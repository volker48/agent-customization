use pr_watch::bots::DEFAULT_BOTS;
use pr_watch::cli::{CommandName, parse_args};
use pr_watch::forge::{ForgeName, detect_forge_from_remote_url};

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

#[test]
fn parses_status_defaults() {
    let parsed = parse_args(&args(&["status"])).unwrap();
    assert_eq!(parsed.command, CommandName::Status);
    assert_eq!(parsed.bots, DEFAULT_BOTS.map(str::to_string));
    assert!(!parsed.all);
    assert!(!parsed.nitpicks);
    assert!(!parsed.no_reviews);
    assert_eq!(parsed.timeout_secs, 1800);
    assert_eq!(parsed.interval_secs, 30);
}

#[test]
fn parses_pr_number_repo_bot_list_and_findings_flags() {
    let parsed = parse_args(&args(&[
        "findings",
        "63",
        "-R",
        "volker48/agent-customization",
        "--bots",
        "coderabbitai,chatgpt-codex-connector",
        "--all",
        "--nitpicks",
        "--no-reviews",
    ]))
    .unwrap();
    assert_eq!(parsed.command, CommandName::Findings);
    assert_eq!(parsed.pr.as_deref(), Some("63"));
    assert_eq!(parsed.repo.as_deref(), Some("volker48/agent-customization"));
    assert_eq!(
        parsed.bots,
        ["coderabbitai", "chatgpt-codex-connector"].map(str::to_string)
    );
    assert!(parsed.all && parsed.nitpicks && parsed.no_reviews);
}

#[test]
fn supports_inline_value_flags() {
    let parsed = parse_args(&args(&[
        "wait",
        "--repo=volker48/agent-customization",
        "--bots=coderabbitai",
        "--forge=gitlab",
        "--timeout=60",
        "--interval=5",
        "63",
    ]))
    .unwrap();
    assert_eq!(parsed.command, CommandName::Wait);
    assert_eq!(parsed.pr.as_deref(), Some("63"));
    assert_eq!(parsed.forge, Some(ForgeName::GitLab));
    assert_eq!(parsed.timeout_secs, 60);
    assert_eq!(parsed.interval_secs, 5);
}

#[test]
fn rejects_unknown_or_missing_subcommands() {
    assert!(
        parse_args(&args(&[]))
            .unwrap_err()
            .to_string()
            .contains("missing subcommand")
    );
    assert!(
        parse_args(&args(&["checks"]))
            .unwrap_err()
            .to_string()
            .contains("unknown subcommand")
    );
}

#[test]
fn parses_and_rejects_forge_flags() {
    assert_eq!(
        parse_args(&args(&["status", "--forge", "github"]))
            .unwrap()
            .forge,
        Some(ForgeName::GitHub)
    );
    assert_eq!(
        parse_args(&args(&["status", "--forge=gitlab"]))
            .unwrap()
            .forge,
        Some(ForgeName::GitLab)
    );
    assert!(
        parse_args(&args(&["status", "--forge", "bitbucket"]))
            .unwrap_err()
            .to_string()
            .contains("github or gitlab")
    );
}

#[test]
fn rejects_unknown_flags_and_missing_flag_values() {
    assert!(
        parse_args(&args(&["status", "--bad"]))
            .unwrap_err()
            .to_string()
            .contains("unknown flag")
    );
    assert!(
        parse_args(&args(&["status", "--repo"]))
            .unwrap_err()
            .to_string()
            .contains("requires a value")
    );
}

#[test]
fn rejects_invalid_or_duplicate_pr_numbers() {
    assert!(
        parse_args(&args(&["status", "feature-branch"]))
            .unwrap_err()
            .to_string()
            .contains("invalid PR number")
    );
    assert!(
        parse_args(&args(&["status", "63", "64"]))
            .unwrap_err()
            .to_string()
            .contains("unexpected positional")
    );
}

#[test]
fn rejects_wait_only_flags_outside_wait() {
    assert!(
        parse_args(&args(&["status", "--timeout", "60"]))
            .unwrap_err()
            .to_string()
            .contains("only valid with wait")
    );
    assert!(
        parse_args(&args(&["findings", "--interval=5"]))
            .unwrap_err()
            .to_string()
            .contains("only valid with wait")
    );
}

#[test]
fn rejects_empty_bot_lists_and_non_positive_intervals() {
    assert!(
        parse_args(&args(&["status", "--bots="]))
            .unwrap_err()
            .to_string()
            .contains("at least one bot")
    );
    assert!(
        parse_args(&args(&["wait", "--interval", "0"]))
            .unwrap_err()
            .to_string()
            .contains("between 1")
    );
}

#[test]
fn rejects_oversized_wait_durations() {
    assert!(
        parse_args(&args(&["wait", "--timeout", "18446744073709551615"]))
            .unwrap_err()
            .to_string()
            .contains("between 1")
    );
}

#[test]
fn selects_gitlab_when_origin_host_contains_gitlab() {
    assert_eq!(
        detect_forge_from_remote_url(Some("https://gitlab.com/group/project.git")),
        ForgeName::GitLab
    );
    assert_eq!(
        detect_forge_from_remote_url(Some("git@gitlab.example.com:group/project.git")),
        ForgeName::GitLab
    );
}

#[test]
fn defaults_to_github_for_non_gitlab_or_missing_origins() {
    assert_eq!(
        detect_forge_from_remote_url(Some("https://github.com/org/repo.git")),
        ForgeName::GitHub
    );
    assert_eq!(detect_forge_from_remote_url(None), ForgeName::GitHub);
}
