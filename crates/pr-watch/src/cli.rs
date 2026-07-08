use std::thread::sleep;
use std::time::{Duration, Instant};

use crate::bots::DEFAULT_BOTS;
use crate::core::{
    Finding, PrSnapshot, SettleOptions, SettleResult, evaluate_settled, exit_code_for,
    render_findings, render_status, unresolved_findings,
};
use crate::forge::{
    CliError, ForgeName, ForgeProvider, SnapshotFetchOptions, UsageError, auto_detect_forge,
};
use crate::github::create_github_provider;
use crate::gitlab::create_gitlab_provider;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandName {
    Status,
    Findings,
    Wait,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliOptions {
    pub command: CommandName,
    pub pr: Option<String>,
    pub repo: Option<String>,
    pub bots: Vec<String>,
    pub forge: Option<ForgeName>,
    pub all: bool,
    pub nitpicks: bool,
    pub no_reviews: bool,
    pub timeout_secs: u64,
    pub interval_secs: u64,
}

struct ParseState {
    opts: CliOptions,
    wait_flag_used: bool,
}

enum ValueFlag {
    Repo,
    Bots,
    TimeoutSecs,
    IntervalSecs,
    Forge,
}

pub fn parse_args(argv: &[String]) -> Result<CliOptions, UsageError> {
    let command = parse_command(argv.first().map(String::as_str))?;
    let mut state = ParseState {
        opts: default_options(command),
        wait_flag_used: false,
    };
    let mut index = 1;
    while index < argv.len() {
        index = consume_token(argv, index, &mut state)?;
    }
    if state.wait_flag_used && state.opts.command != CommandName::Wait {
        return Err(UsageError::new(
            "--timeout and --interval are only valid with wait",
        ));
    }
    Ok(state.opts)
}

fn parse_command(value: Option<&str>) -> Result<CommandName, UsageError> {
    match value {
        Some("status") => Ok(CommandName::Status),
        Some("findings") => Ok(CommandName::Findings),
        Some("wait") => Ok(CommandName::Wait),
        Some(value) => Err(UsageError::new(format!("unknown subcommand: {value}"))),
        None => Err(UsageError::new("missing subcommand")),
    }
}

fn default_options(command: CommandName) -> CliOptions {
    CliOptions {
        command,
        pr: None,
        repo: None,
        bots: DEFAULT_BOTS.iter().map(|s| s.to_string()).collect(),
        forge: None,
        all: false,
        nitpicks: false,
        no_reviews: false,
        timeout_secs: 1800,
        interval_secs: 30,
    }
}

fn consume_token(
    argv: &[String],
    index: usize,
    state: &mut ParseState,
) -> Result<usize, UsageError> {
    let arg = &argv[index];
    if assign_bool_flag(arg, state) {
        return Ok(index + 1);
    }
    if let Some((flag, value)) = inline_value(arg) {
        if let Some(value_flag) = value_flag(flag) {
            assign_value(state, value_flag, value)?;
            return Ok(index + 1);
        }
    }
    if let Some(value_flag) = value_flag(arg) {
        assign_value(state, value_flag, &required_value(argv, index, arg)?)?;
        return Ok(index + 2);
    }
    if arg.starts_with('-') {
        return Err(UsageError::new(format!("unknown flag: {arg}")));
    }
    assign_pr(&mut state.opts, arg)?;
    Ok(index + 1)
}

fn assign_bool_flag(arg: &str, state: &mut ParseState) -> bool {
    match arg {
        "--all" => state.opts.all = true,
        "--nitpicks" => state.opts.nitpicks = true,
        "--no-reviews" => state.opts.no_reviews = true,
        _ => return false,
    }
    true
}

fn inline_value(arg: &str) -> Option<(&str, &str)> {
    if !arg.starts_with("--") {
        return None;
    }
    let index = arg.find('=')?;
    Some((&arg[..index], &arg[index + 1..]))
}

fn value_flag(flag: &str) -> Option<ValueFlag> {
    match flag {
        "--repo" | "-R" => Some(ValueFlag::Repo),
        "--bots" => Some(ValueFlag::Bots),
        "--forge" => Some(ValueFlag::Forge),
        "--timeout" => Some(ValueFlag::TimeoutSecs),
        "--interval" => Some(ValueFlag::IntervalSecs),
        _ => None,
    }
}

fn required_value(argv: &[String], index: usize, flag: &str) -> Result<String, UsageError> {
    match argv.get(index + 1) {
        Some(value) if !value.starts_with('-') => Ok(value.clone()),
        _ => Err(UsageError::new(format!("{flag} requires a value"))),
    }
}

fn assign_pr(opts: &mut CliOptions, value: &str) -> Result<(), UsageError> {
    if !value.chars().all(|ch| ch.is_ascii_digit()) {
        return Err(UsageError::new(format!("invalid PR number: {value}")));
    }
    if opts.pr.is_some() {
        return Err(UsageError::new(format!(
            "unexpected positional argument: {value}"
        )));
    }
    opts.pr = Some(value.to_string());
    Ok(())
}

fn assign_value(state: &mut ParseState, flag: ValueFlag, value: &str) -> Result<(), UsageError> {
    match flag {
        ValueFlag::Repo => state.opts.repo = Some(non_empty(value, "--repo")?),
        ValueFlag::Bots => state.opts.bots = parse_bots(value)?,
        ValueFlag::Forge => state.opts.forge = Some(parse_forge(value)?),
        ValueFlag::TimeoutSecs => {
            state.opts.timeout_secs = parse_seconds(state, value, "--timeout")?
        }
        ValueFlag::IntervalSecs => {
            state.opts.interval_secs = parse_seconds(state, value, "--interval")?
        }
    }
    Ok(())
}

fn non_empty(value: &str, flag: &str) -> Result<String, UsageError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err(UsageError::new(format!("{flag} requires a value")))
    } else {
        Ok(trimmed.to_string())
    }
}

fn parse_bots(value: &str) -> Result<Vec<String>, UsageError> {
    let bots: Vec<String> = value
        .split(',')
        .map(str::trim)
        .filter(|bot| !bot.is_empty())
        .map(str::to_string)
        .collect();
    if bots.is_empty() {
        return Err(UsageError::new("--bots requires at least one bot"));
    }
    Ok(bots)
}

fn parse_forge(value: &str) -> Result<ForgeName, UsageError> {
    match value {
        "github" => Ok(ForgeName::GitHub),
        "gitlab" => Ok(ForgeName::GitLab),
        _ => Err(UsageError::new("--forge must be github or gitlab")),
    }
}

fn parse_seconds(state: &mut ParseState, value: &str, flag: &str) -> Result<u64, UsageError> {
    state.wait_flag_used = true;
    match value.parse::<f64>() {
        Ok(seconds) if seconds.is_finite() && seconds > 0.0 && seconds.fract() == 0.0 => {
            Ok(seconds as u64)
        }
        _ => Err(UsageError::new(format!(
            "{flag} must be a positive integer number of seconds"
        ))),
    }
}

pub fn run(argv: &[String]) -> i32 {
    match run_inner(argv) {
        Ok(code) => code,
        Err(RunError::Usage(error)) => {
            eprintln!("{}\n{}", error.0.message, usage());
            error.0.exit_code
        }
        Err(RunError::Cli(error)) => {
            eprintln!("{}", error.message);
            error.exit_code
        }
    }
}

enum RunError {
    Usage(UsageError),
    Cli(CliError),
}

fn run_inner(argv: &[String]) -> Result<i32, RunError> {
    let opts = parse_args(argv).map_err(RunError::Usage)?;
    match opts.command {
        CommandName::Status => run_status(&opts).map_err(RunError::Cli),
        CommandName::Findings => run_findings(&opts).map_err(RunError::Cli),
        CommandName::Wait => run_wait(&opts).map_err(RunError::Cli),
    }
}

fn run_status(opts: &CliOptions) -> Result<i32, CliError> {
    let snapshot = fetch_snapshot(opts)?;
    let settle = evaluate_settled(&snapshot, &settle_options(opts));
    println!("{}", render_status(&snapshot, &settle, None));
    Ok(exit_code_for(&snapshot, &settle))
}

fn run_findings(opts: &CliOptions) -> Result<i32, CliError> {
    let snapshot = fetch_snapshot(opts)?;
    println!(
        "{}",
        render_findings(&selected_findings(&snapshot, opts), "findings")
    );
    Ok(0)
}

fn run_wait(opts: &CliOptions) -> Result<i32, CliError> {
    let deadline = Instant::now() + Duration::from_secs(opts.timeout_secs);
    loop {
        match fetch_snapshot(opts) {
            Ok(snapshot) => {
                let settle = evaluate_settled(&snapshot, &settle_options(opts));
                if settle.settled {
                    return finish_wait(&snapshot, &settle, opts);
                }
                if Instant::now() >= deadline {
                    println!("{}", wait_output(&snapshot, &settle, opts, Some("TIMEOUT")));
                    return Ok(3);
                }
            }
            Err(error) if error.retryable && Instant::now() < deadline => {}
            Err(error) => return Err(error),
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        sleep(Duration::from_secs(opts.interval_secs).min(remaining));
    }
}

fn finish_wait(
    snapshot: &PrSnapshot,
    settle: &SettleResult,
    opts: &CliOptions,
) -> Result<i32, CliError> {
    println!("{}", wait_output(snapshot, settle, opts, None));
    Ok(exit_code_for(snapshot, settle))
}

fn wait_output(
    snapshot: &PrSnapshot,
    settle: &SettleResult,
    opts: &CliOptions,
    label: Option<&str>,
) -> String {
    let findings = selected_findings(snapshot, opts);
    let mut blocks = vec![render_status(snapshot, settle, label)];
    if !unresolved_findings(snapshot).is_empty() {
        blocks.push(render_findings(&findings, "findings"));
    }
    blocks.join("\n\n")
}

fn selected_findings(snapshot: &PrSnapshot, opts: &CliOptions) -> Vec<Finding> {
    if opts.all {
        snapshot.findings.clone()
    } else {
        unresolved_findings(snapshot)
    }
}

fn settle_options(opts: &CliOptions) -> SettleOptions {
    SettleOptions {
        no_reviews: opts.no_reviews,
        bots: opts.bots.clone(),
    }
}

fn fetch_snapshot(opts: &CliOptions) -> Result<PrSnapshot, CliError> {
    let fetch_opts = SnapshotFetchOptions {
        pr: opts.pr.clone(),
        repo: opts.repo.clone(),
        bots: opts.bots.clone(),
        nitpicks: opts.nitpicks,
    };
    match opts.forge.unwrap_or_else(auto_detect_forge) {
        ForgeName::GitLab => create_gitlab_provider().fetch_snapshot(&fetch_opts),
        ForgeName::GitHub => create_github_provider().fetch_snapshot(&fetch_opts),
    }
}

pub fn usage() -> String {
    [
        "Usage: pr-watch status|findings|wait [<pr>] [options]",
        "Options:",
        "  -R, --repo <owner/repo>",
        "  --forge <github|gitlab>  default: auto (origin host containing gitlab => gitlab)",
        "  --bots <csv>",
        "  --all",
        "  --nitpicks",
        "  --no-reviews",
        "  --timeout <secs>        wait only (default 1800)",
        "  --interval <secs>       wait only (default 30)",
    ]
    .join("\n")
}
