use regex::Regex;
use serde_json::Value;

use crate::bots::adapter_for_login;
use crate::core::{
    BotReview, CheckState, PrCheck, PrSnapshot, ReviewData, ReviewThread, findings_from_threads,
};
use crate::forge::{
    CliError, ForgeProvider, SnapshotFetchOptions, pagination_failure, parse_json_failure, run_json,
};

pub const REVIEW_QUERY: &str = r#"
query($owner: String!, $name: String!, $number: Int!, $reviewThreadsCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(last: 50) {
        nodes {
          author { login }
          state
          submittedAt
          body
          commit { oid }
        }
      }
      reviewThreads(first: 100, after: $reviewThreadsCursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          isResolved
          isOutdated
          path
          line
          startLine
          comments(first: 5) {
            nodes {
              author { login }
              body
            }
          }
        }
      }
    }
  }
}
"#;

pub struct GitHubProvider;

impl ForgeProvider for GitHubProvider {
    fn fetch_snapshot(&self, opts: &SnapshotFetchOptions) -> Result<PrSnapshot, CliError> {
        let mut snapshot = parse_pr_view_json(run_json("gh", &pr_view_args(opts), "gh pr view")?)?;
        let reviews = fetch_review_data(&snapshot, &opts.bots)?;
        snapshot.bot_reviews = reviews.bot_reviews;
        snapshot.findings = if opts.nitpicks {
            reviews
                .findings
                .into_iter()
                .chain(reviews.nitpicks)
                .collect()
        } else {
            reviews.findings
        };
        Ok(snapshot)
    }
}

pub fn create_github_provider() -> GitHubProvider {
    GitHubProvider
}

pub fn parse_pr_view(raw: &Value) -> Result<PrSnapshot, String> {
    let url = raw.get("url").and_then(Value::as_str).unwrap_or("");
    let re = Regex::new(r"github\.com/([^/]+)/([^/]+)/pull/").unwrap();
    let caps = re
        .captures(url)
        .ok_or_else(|| format!("cannot derive owner/repo from PR url: {url}"))?;
    let commits = raw
        .get("commits")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let last_commit = commits
        .last()
        .and_then(|v| v.get("committedDate"))
        .and_then(Value::as_str);
    Ok(PrSnapshot {
        number: required_u64(raw, "number")?,
        title: required_str(raw, "title")?,
        state: required_str(raw, "state")?,
        is_draft: raw.get("isDraft").and_then(Value::as_bool).unwrap_or(false),
        head_ref_name: required_str(raw, "headRefName")?,
        base_ref_name: required_str(raw, "baseRefName")?,
        head_oid: required_str(raw, "headRefOid")?,
        head_committed_at: last_commit.map(str::to_string),
        owner: caps.get(1).unwrap().as_str().to_string(),
        repo: caps.get(2).unwrap().as_str().to_string(),
        checks: parse_github_checks(raw.get("statusCheckRollup").and_then(Value::as_array)),
        bot_reviews: Vec::new(),
        findings: Vec::new(),
    })
}

pub fn parse_review_data(raw: &Value, bots: &[String]) -> ReviewData {
    let pr = &raw["data"]["repository"]["pullRequest"];
    let reviews = pr["reviews"]["nodes"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let bot_reviews = reviews
        .iter()
        .filter_map(|review| parse_bot_review(review, bots))
        .collect();
    let nitpicks = reviews
        .iter()
        .flat_map(|review| parse_review_nitpicks(review, bots))
        .collect();
    let findings = findings_from_threads(&github_threads(pr), bots);
    ReviewData {
        bot_reviews,
        findings,
        nitpicks,
    }
}

fn parse_bot_review(review: &Value, bots: &[String]) -> Option<BotReview> {
    let login = review["author"]["login"].as_str().unwrap_or("");
    let adapter = adapter_for_login(login, bots)?;
    let body = review.get("body").and_then(Value::as_str).unwrap_or("");
    let actionable = adapter.actionable_count(body);
    Some(BotReview {
        bot: adapter.short_name,
        submitted_at: review.get("submittedAt")?.as_str()?.to_string(),
        commit_oid: review["commit"]["oid"].as_str().map(str::to_string),
        actionable,
    })
}

fn parse_review_nitpicks(review: &Value, bots: &[String]) -> Vec<crate::core::Finding> {
    let login = review["author"]["login"].as_str().unwrap_or("");
    let Some(adapter) = adapter_for_login(login, bots) else {
        return Vec::new();
    };
    adapter.review_body_findings(review.get("body").and_then(Value::as_str).unwrap_or(""))
}

fn parse_github_checks(checks: Option<&Vec<Value>>) -> Vec<PrCheck> {
    checks
        .unwrap_or(&Vec::new())
        .iter()
        .map(|check| {
            if check.get("__typename").and_then(Value::as_str) == Some("StatusContext") {
                return PrCheck {
                    name: check
                        .get("context")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string(),
                    state: status_context_state(
                        check.get("state").and_then(Value::as_str).unwrap_or(""),
                    ),
                };
            }
            PrCheck {
                name: check
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string(),
                state: check_run_state(
                    check.get("status").and_then(Value::as_str).unwrap_or(""),
                    check.get("conclusion").and_then(Value::as_str),
                ),
            }
        })
        .collect()
}

fn github_threads(pr: &Value) -> Vec<ReviewThread> {
    let nodes = pr["reviewThreads"]["nodes"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    nodes
        .iter()
        .filter_map(|thread| {
            let first = thread["comments"]["nodes"].as_array()?.first()?;
            Some(ReviewThread {
                path: thread.get("path")?.as_str()?.to_string(),
                line: thread.get("line").and_then(Value::as_u64),
                start_line: thread.get("startLine").and_then(Value::as_u64),
                author: first["author"]["login"].as_str().unwrap_or("").to_string(),
                body: first
                    .get("body")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                resolved: thread
                    .get("isResolved")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                outdated: thread
                    .get("isOutdated")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect()
}

fn check_run_state(status: &str, conclusion: Option<&str>) -> CheckState {
    if status != "COMPLETED" {
        return CheckState::Pending;
    }
    match conclusion {
        Some("SUCCESS" | "NEUTRAL") => CheckState::Passed,
        Some("SKIPPED") => CheckState::Skipped,
        _ => CheckState::Failed,
    }
}

fn status_context_state(state: &str) -> CheckState {
    match state {
        "SUCCESS" => CheckState::Passed,
        "PENDING" | "EXPECTED" => CheckState::Pending,
        _ => CheckState::Failed,
    }
}

fn pr_view_args(opts: &SnapshotFetchOptions) -> Vec<String> {
    let mut args = vec!["pr".to_string(), "view".to_string()];
    if let Some(pr) = &opts.pr {
        args.push(pr.clone());
    }
    if let Some(repo) = &opts.repo {
        args.extend(["-R".to_string(), repo.clone()]);
    }
    args.extend(["--json".to_string(), pr_view_fields().join(",")]);
    args
}

fn pr_view_fields() -> Vec<&'static str> {
    vec![
        "number",
        "title",
        "state",
        "isDraft",
        "headRefName",
        "baseRefName",
        "headRefOid",
        "statusCheckRollup",
        "commits",
        "url",
    ]
}

fn review_args(snapshot: &PrSnapshot, cursor: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "api".to_string(),
        "graphql".to_string(),
        "-f".to_string(),
        format!("query={}", REVIEW_QUERY.trim()),
        "-F".to_string(),
        format!("owner={}", snapshot.owner),
        "-F".to_string(),
        format!("name={}", snapshot.repo),
        "-F".to_string(),
        format!("number={}", snapshot.number),
    ];
    if let Some(cursor) = cursor {
        args.extend(["-F".to_string(), format!("reviewThreadsCursor={cursor}")]);
    }
    args
}

fn fetch_review_data(snapshot: &PrSnapshot, bots: &[String]) -> Result<ReviewData, CliError> {
    let mut first = run_json("gh", &review_args(snapshot, None), "gh api graphql")?;
    loop {
        let page_info = &first["data"]["repository"]["pullRequest"]["reviewThreads"]["pageInfo"];
        if !page_info["hasNextPage"].as_bool().unwrap_or(false) {
            break;
        }
        let cursor = page_info["endCursor"]
            .as_str()
            .ok_or_else(|| pagination_failure("gh api graphql pagination"))?;
        let next = run_json("gh", &review_args(snapshot, Some(cursor)), "gh api graphql")?;
        append_review_threads(&mut first, &next);
    }
    Ok(parse_review_data(&first, bots))
}

fn append_review_threads(first: &mut Value, next: &Value) {
    let dst = first["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"].as_array_mut();
    let src = next["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"].as_array();
    if let (Some(dst), Some(src)) = (dst, src) {
        dst.extend(src.iter().cloned());
    }
    first["data"]["repository"]["pullRequest"]["reviewThreads"]["pageInfo"] =
        next["data"]["repository"]["pullRequest"]["reviewThreads"]["pageInfo"].clone();
}

fn parse_pr_view_json(raw: Value) -> Result<PrSnapshot, CliError> {
    parse_pr_view(&raw)
        .map_err(|error| parse_json_failure("could not parse gh pr view output", error))
}

fn required_str(raw: &Value, field: &str) -> Result<String, String> {
    raw.get(field)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("missing {field}"))
}

fn required_u64(raw: &Value, field: &str) -> Result<u64, String> {
    raw.get(field)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("missing {field}"))
}
