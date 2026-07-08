use crate::bots::{DEFAULT_BOTS, adapter_for_login, adapters_for_bots};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckState {
    Pending,
    Passed,
    Failed,
    Skipped,
}

impl CheckState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrCheck {
    pub name: String,
    pub state: CheckState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BotReview {
    pub bot: String,
    pub submitted_at: String,
    pub commit_oid: Option<String>,
    pub actionable: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub path: String,
    pub line: String,
    pub bot: String,
    pub severity: Option<String>,
    pub title: String,
    pub detail: String,
    pub resolved: bool,
    pub outdated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewThread {
    pub path: String,
    pub line: Option<u64>,
    pub start_line: Option<u64>,
    pub author: String,
    pub body: String,
    pub resolved: bool,
    pub outdated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrSnapshot {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub is_draft: bool,
    pub head_ref_name: String,
    pub base_ref_name: String,
    pub head_oid: String,
    pub head_committed_at: Option<String>,
    pub owner: String,
    pub repo: String,
    pub checks: Vec<PrCheck>,
    pub bot_reviews: Vec<BotReview>,
    pub findings: Vec<Finding>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewData {
    pub bot_reviews: Vec<BotReview>,
    pub findings: Vec<Finding>,
    pub nitpicks: Vec<Finding>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettleOptions {
    pub no_reviews: bool,
    pub bots: Vec<String>,
}

impl Default for SettleOptions {
    fn default() -> Self {
        Self {
            no_reviews: false,
            bots: DEFAULT_BOTS.iter().map(|s| s.to_string()).collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettleResult {
    pub settled: bool,
    pub checks_pending: usize,
    pub review_landed: bool,
}

pub fn format_line_range(start_line: Option<u64>, line: Option<u64>) -> String {
    match (start_line, line) {
        (Some(start), Some(end)) if start != end => format!("{start}-{end}"),
        (_, Some(line)) => line.to_string(),
        _ => "?".to_string(),
    }
}

pub fn finding_from_thread(thread: &ReviewThread, bots: &[String]) -> Option<Finding> {
    let adapter = adapter_for_login(&thread.author, bots)?;
    let distilled = adapter.distill(&thread.body);
    Some(Finding {
        path: thread.path.clone(),
        line: format_line_range(thread.start_line, thread.line),
        bot: adapter.short_name,
        severity: distilled.severity,
        title: distilled.title,
        detail: distilled.detail,
        resolved: thread.resolved,
        outdated: thread.outdated,
    })
}

pub fn findings_from_threads(threads: &[ReviewThread], bots: &[String]) -> Vec<Finding> {
    threads
        .iter()
        .filter_map(|thread| finding_from_thread(thread, bots))
        .collect()
}

pub fn hoist_shared_preamble(findings: &[Finding]) -> (Option<String>, Vec<Finding>) {
    if findings.len() < 2 {
        return (None, findings.to_vec());
    }
    let splits: Vec<(Option<String>, String)> = findings.iter().map(split_detail).collect();
    let first = match &splits[0].0 {
        Some(value) if !value.is_empty() => value.clone(),
        _ => return (None, findings.to_vec()),
    };
    if !splits.iter().all(|(head, _)| head.as_ref() == Some(&first)) {
        return (None, findings.to_vec());
    }
    let hoisted = findings.iter().zip(splits).map(|(finding, (_, rest))| {
        let mut item = finding.clone();
        item.detail = rest;
        item
    });
    (Some(first), hoisted.collect())
}

fn split_detail(finding: &Finding) -> (Option<String>, String) {
    match finding.detail.find("\n\n") {
        Some(index) => (
            Some(finding.detail[..index].trim().to_string()),
            finding.detail[index + 2..].trim().to_string(),
        ),
        None => (None, finding.detail.clone()),
    }
}

pub fn evaluate_settled(snapshot: &PrSnapshot, opts: &SettleOptions) -> SettleResult {
    let checks_pending = snapshot
        .checks
        .iter()
        .filter(|c| c.state == CheckState::Pending)
        .count();
    let review_landed = snapshot
        .bot_reviews
        .iter()
        .any(|r| review_matches_head(snapshot, r))
        || bot_check_landed(snapshot, &opts.bots);
    let terminal = snapshot.state != "OPEN";
    let settled = terminal || (checks_pending == 0 && (review_landed || opts.no_reviews));
    SettleResult {
        settled,
        checks_pending,
        review_landed,
    }
}

fn review_matches_head(snapshot: &PrSnapshot, review: &BotReview) -> bool {
    if review.commit_oid.as_deref() == Some(snapshot.head_oid.as_str()) {
        return true;
    }
    match &snapshot.head_committed_at {
        // Preserve TS behavior: compare ISO-like timestamps lexicographically, not semantically.
        Some(committed_at) => review.submitted_at >= *committed_at,
        None => false,
    }
}

fn bot_check_landed(snapshot: &PrSnapshot, bots: &[String]) -> bool {
    let names: Vec<String> = adapters_for_bots(bots)
        .into_iter()
        .flat_map(|adapter| adapter.check_names)
        .map(|name| name.to_lowercase())
        .collect();
    snapshot.checks.iter().any(|check| {
        check.state != CheckState::Pending && names.contains(&check.name.to_lowercase())
    })
}

pub fn unresolved_findings(snapshot: &PrSnapshot) -> Vec<Finding> {
    snapshot
        .findings
        .iter()
        .filter(|f| !f.resolved && !f.outdated)
        .cloned()
        .collect()
}

pub fn exit_code_for(snapshot: &PrSnapshot, settle: &SettleResult) -> i32 {
    if !settle.settled {
        return 3;
    }
    if snapshot
        .checks
        .iter()
        .any(|c| c.state == CheckState::Failed)
    {
        return 2;
    }
    if !unresolved_findings(snapshot).is_empty() {
        return 1;
    }
    0
}

pub fn render_status(snapshot: &PrSnapshot, settle: &SettleResult, label: Option<&str>) -> String {
    let draft = if snapshot.is_draft { " DRAFT" } else { "" };
    let mut lines = vec![format!(
        "PR #{} {} → {} [{}{}] {}",
        snapshot.number,
        snapshot.head_ref_name,
        snapshot.base_ref_name,
        snapshot.state,
        draft,
        snapshot.title
    )];
    lines.push(format!("head {}", first_chars(&snapshot.head_oid, 8)));
    for check in &snapshot.checks {
        lines.push(format!("check {:<7} {}", check.state.as_str(), check.name));
    }
    if snapshot.bot_reviews.is_empty() {
        lines.push("reviews (none from bots)".to_string());
    }
    for review in &snapshot.bot_reviews {
        let oid = review
            .commit_oid
            .as_ref()
            .map(|v| format!("@{}", first_chars(v, 8)))
            .unwrap_or_default();
        let actionable = review
            .actionable
            .map(|v| format!(" actionable={v}"))
            .unwrap_or_default();
        lines.push(format!(
            "review {} {}{} at {}",
            review.bot, oid, actionable, review.submitted_at
        ));
    }
    lines.push(summary_line(snapshot, settle, label));
    lines.join("\n")
}

fn first_chars(value: &str, count: usize) -> String {
    value.chars().take(count).collect()
}

fn summary_line(snapshot: &PrSnapshot, settle: &SettleResult, label: Option<&str>) -> String {
    let passed = snapshot
        .checks
        .iter()
        .filter(|c| c.state == CheckState::Passed)
        .count();
    let failed = snapshot
        .checks
        .iter()
        .filter(|c| c.state == CheckState::Failed)
        .count();
    let state = label.unwrap_or(if settle.settled { "SETTLED" } else { "PENDING" });
    let mut parts = vec![
        state.to_string(),
        format!("findings={}", unresolved_findings(snapshot).len()),
        format!("checks={passed}/{}", snapshot.checks.len()),
    ];
    if failed > 0 {
        parts.push(format!("failed={failed}"));
    }
    parts.join(" ")
}

pub fn render_findings(findings: &[Finding], heading: &str) -> String {
    if findings.is_empty() {
        return format!("{heading}: none");
    }
    let (preamble, hoisted) = hoist_shared_preamble(findings);
    let mut lines = vec![format!("{heading} ({}):", findings.len())];
    if let Some(text) = preamble {
        lines.push(String::new());
        lines.push(format!("reviewer instruction: {}", text.replace('\n', " ")));
    }
    for (index, finding) in hoisted.iter().enumerate() {
        lines.push(String::new());
        lines.push(finding_header(index + 1, finding));
        lines.push(format!("   {}", finding.title));
        for detail_line in finding.detail.split('\n') {
            lines.push(format!("   {detail_line}").trim_end().to_string());
        }
    }
    lines.join("\n")
}

fn finding_header(index: usize, finding: &Finding) -> String {
    let severity = finding
        .severity
        .as_ref()
        .map(|s| format!(" {s}"))
        .unwrap_or_default();
    let flags = finding_flags(finding);
    let suffix = if flags.is_empty() {
        String::new()
    } else {
        format!(" ({flags})")
    };
    format!(
        "{index}. {}:{} [{}{}]{}",
        finding.path, finding.line, finding.bot, severity, suffix
    )
}

fn finding_flags(finding: &Finding) -> String {
    let mut flags = Vec::new();
    if finding.resolved {
        flags.push("resolved");
    }
    if finding.outdated {
        flags.push("outdated");
    }
    flags.join(",")
}
