use std::fmt;
use std::io::{self, Read};
use std::process::{Command, Output, Stdio};
use std::thread::{self, JoinHandle, sleep};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::core::PrSnapshot;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForgeName {
    GitHub,
    GitLab,
}

impl ForgeName {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::GitHub => "github",
            Self::GitLab => "gitlab",
        }
    }
}

#[derive(Debug, Clone)]
pub struct SnapshotFetchOptions {
    pub pr: Option<String>,
    pub repo: Option<String>,
    pub bots: Vec<String>,
    pub nitpicks: bool,
}

pub trait ForgeProvider {
    fn fetch_snapshot(&self, opts: &SnapshotFetchOptions) -> Result<PrSnapshot, CliError>;
}

#[derive(Debug, Clone)]
pub struct CliError {
    pub message: String,
    pub exit_code: i32,
    pub retryable: bool,
}

impl CliError {
    pub fn new(message: impl Into<String>, retryable: bool) -> Self {
        Self {
            message: message.into(),
            exit_code: 4,
            retryable,
        }
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for CliError {}

#[derive(Debug, Clone)]
pub struct UsageError(pub CliError);

impl UsageError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(CliError::new(message, false))
    }
}

impl fmt::Display for UsageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0.message)
    }
}

impl std::error::Error for UsageError {}

pub fn detect_forge_from_remote_url(remote_url: Option<&str>) -> ForgeName {
    let host = remote_host(remote_url.unwrap_or(""));
    if host.to_lowercase().contains("gitlab") {
        ForgeName::GitLab
    } else {
        ForgeName::GitHub
    }
}

pub fn auto_detect_forge() -> ForgeName {
    let output = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .output();
    let Ok(output) = output else {
        return ForgeName::GitHub;
    };
    if !output.status.success() {
        return ForgeName::GitHub;
    }
    detect_forge_from_remote_url(Some(String::from_utf8_lossy(&output.stdout).trim()))
}

const CLI_TIMEOUT: Duration = Duration::from_secs(30);

pub fn run_json(command: &str, args: &[String], context: &str) -> Result<Value, CliError> {
    let output = command_output(command, args, context)?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    if let Some(signal) = signal_text(&output) {
        return Err(cli_error(
            &format!("{context} terminated by {signal}"),
            &stderr,
            None,
            true,
        ));
    }
    if !output.status.success() {
        return Err(cli_error(context, &stderr, None, true));
    }
    serde_json::from_slice(&output.stdout).map_err(|error| {
        cli_error(
            &format!("{context} returned invalid JSON"),
            &stderr,
            Some(error.to_string()),
            false,
        )
    })
}

fn command_output(command: &str, args: &[String], context: &str) -> Result<Output, CliError> {
    let mut child = Command::new(command)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| cli_error(context, "", Some(error.to_string()), false))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| cli_error(context, "", Some("missing stdout pipe".to_string()), false))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| cli_error(context, "", Some("missing stderr pipe".to_string()), false))?;
    let stdout_reader = read_stream(stdout);
    let stderr_reader = read_stream(stderr);
    let deadline = Instant::now() + CLI_TIMEOUT;
    loop {
        let status = child
            .try_wait()
            .map_err(|error| cli_error(context, "", Some(error.to_string()), false))?;
        if let Some(status) = status {
            let stdout = join_stream(stdout_reader, context)?;
            let stderr = join_stream(stderr_reader, context)?;
            return Ok(Output {
                status,
                stdout,
                stderr,
            });
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            let _ = join_stream(stdout_reader, context);
            let stderr = join_stream(stderr_reader, context).unwrap_or_default();
            return Err(cli_error(
                context,
                &String::from_utf8_lossy(&stderr),
                Some("operation timed out".to_string()),
                true,
            ));
        }
        sleep(Duration::from_millis(50));
    }
}

fn read_stream<R>(mut stream: R) -> JoinHandle<io::Result<Vec<u8>>>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut output = Vec::new();
        stream.read_to_end(&mut output)?;
        Ok(output)
    })
}

fn join_stream(
    handle: JoinHandle<io::Result<Vec<u8>>>,
    context: &str,
) -> Result<Vec<u8>, CliError> {
    handle
        .join()
        .map_err(|_| {
            cli_error(
                context,
                "",
                Some("output reader panicked".to_string()),
                false,
            )
        })?
        .map_err(|error| cli_error(context, "", Some(error.to_string()), false))
}

#[cfg(unix)]
fn signal_text(output: &std::process::Output) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    output.status.signal().map(|signal| signal.to_string())
}

#[cfg(not(unix))]
fn signal_text(_output: &std::process::Output) -> Option<String> {
    None
}

pub fn run_json_pages<F>(
    mut fetch_page: F,
    context: &str,
    per_page: usize,
) -> Result<Vec<Value>, CliError>
where
    F: FnMut(usize, usize) -> Result<Value, CliError>,
{
    if per_page == 0 {
        return Err(parse_json_failure(
            context,
            "per_page must be greater than zero",
        ));
    }
    let mut results = Vec::new();
    for page in 1.. {
        let value = fetch_page(page, per_page)?;
        let items = json_array_page(value, context, page)?;
        let done = items.len() < per_page;
        results.extend(items);
        if done {
            return Ok(results);
        }
    }
    unreachable!()
}

pub fn collect_json_pages<F>(
    mut fetch_page: F,
    context: &str,
    per_page: usize,
) -> Result<Vec<Value>, CliError>
where
    F: FnMut(usize, usize) -> Value,
{
    run_json_pages(|page, size| Ok(fetch_page(page, size)), context, per_page)
}

pub fn parse_json_failure(context: &str, cause: impl fmt::Display) -> CliError {
    cli_error(context, "", Some(cause.to_string()), false)
}

pub fn pagination_failure(context: &str) -> CliError {
    cli_error(context, "", None, false)
}

fn json_array_page(value: Value, context: &str, page: usize) -> Result<Vec<Value>, CliError> {
    match value {
        Value::Array(items) => Ok(items),
        _ => Err(parse_json_failure(
            &format!("{context} page {page} returned a non-array JSON document"),
            "null",
        )),
    }
}

fn cli_error(context: &str, stderr: &str, cause: Option<String>, retryable: bool) -> CliError {
    let mut lines = vec![format!("{context} failed")];
    if !stderr.trim().is_empty() {
        lines.push(stderr.trim_end().to_string());
    }
    if let Some(cause) = cause {
        lines.push(cause);
    }
    CliError::new(lines.join("\n"), retryable)
}

fn remote_host(remote_url: &str) -> String {
    if remote_url.trim().is_empty() {
        return String::new();
    }
    if let Some(rest) = remote_url.split("://").nth(1) {
        return rest.split('/').next().unwrap_or("").to_string();
    }
    if let Some(index) = remote_url.find('@') {
        let rest = &remote_url[index + 1..];
        if let Some(colon) = rest.find(':') {
            return rest[..colon].to_string();
        }
    }
    remote_url
        .split([':', '/'])
        .next()
        .unwrap_or(remote_url)
        .to_string()
}
