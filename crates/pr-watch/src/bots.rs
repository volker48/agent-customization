// Regex keeps the Rust bot markdown parsers aligned with the original TS regex behavior.
use regex::Regex;

use crate::core::Finding;

pub const DEFAULT_BOTS: [&str; 3] = ["coderabbitai", "chatgpt-codex-connector", "cursor"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Distilled {
    pub severity: Option<String>,
    pub title: String,
    pub detail: String,
}

#[derive(Clone)]
pub struct BotAdapter {
    pub login: String,
    pub short_name: String,
    pub check_names: Vec<String>,
}

impl BotAdapter {
    pub fn distill(&self, body: &str) -> Distilled {
        match self.login.as_str() {
            "coderabbitai" => distill_code_rabbit(body),
            "chatgpt-codex-connector" => distill_codex(body),
            "cursor" => distill_bugbot(body),
            _ => generic_distill(body),
        }
    }

    pub fn actionable_count(&self, body: &str) -> Option<u32> {
        match self.login.as_str() {
            "coderabbitai" => parse_code_rabbit_actionable_count(body),
            "cursor" => parse_bugbot_actionable_count(body),
            _ => None,
        }
    }

    pub fn review_body_findings(&self, body: &str) -> Vec<Finding> {
        if self.login == "coderabbitai" {
            parse_nitpicks(body, "coderabbit")
        } else {
            Vec::new()
        }
    }
}

pub fn normalize_bot_login(login: &str) -> String {
    let lower = login.to_lowercase();
    if lower.ends_with("[bot]") {
        lower[..lower.len() - 5].to_string()
    } else {
        lower
    }
}

pub fn adapter_for_login(login: &str, configured_bots: &[String]) -> Option<BotAdapter> {
    let normalized = normalize_bot_login(login);
    let configured: Vec<String> = if configured_bots.is_empty() {
        DEFAULT_BOTS.iter().map(|s| s.to_string()).collect()
    } else {
        configured_bots
            .iter()
            .map(|s| normalize_bot_login(s))
            .collect()
    };
    if configured.iter().any(|bot| bot == &normalized) {
        Some(known_or_generic_adapter(&normalized))
    } else {
        None
    }
}

pub fn adapters_for_bots(bots: &[String]) -> Vec<BotAdapter> {
    let configured: Vec<String> = if bots.is_empty() {
        DEFAULT_BOTS.iter().map(|s| s.to_string()).collect()
    } else {
        bots.to_vec()
    };
    configured
        .iter()
        .map(|login| known_or_generic_adapter(&normalize_bot_login(login)))
        .collect()
}

pub fn distill_comment(login: &str, body: &str) -> Distilled {
    adapter_for_login(login, &[])
        .map_or_else(|| generic_distill(body), |adapter| adapter.distill(body))
}

fn known_or_generic_adapter(login: &str) -> BotAdapter {
    match login {
        "coderabbitai" => BotAdapter {
            login: login.to_string(),
            short_name: "coderabbit".to_string(),
            check_names: vec!["coderabbitai".to_string(), "coderabbit".to_string()],
        },
        "chatgpt-codex-connector" => BotAdapter {
            login: login.to_string(),
            short_name: "codex".to_string(),
            check_names: vec!["chatgpt-codex-connector".to_string(), "codex".to_string()],
        },
        "cursor" => BotAdapter {
            login: login.to_string(),
            short_name: "bugbot".to_string(),
            check_names: vec!["cursor".to_string(), "bugbot".to_string()],
        },
        _ => BotAdapter {
            login: login.to_string(),
            short_name: login.to_string(),
            check_names: vec![login.to_string()],
        },
    }
}

fn generic_distill(body: &str) -> Distilled {
    Distilled {
        severity: None,
        title: first_prose_line(body),
        detail: strip_noise(body),
    }
}

fn parse_code_rabbit_actionable_count(body: &str) -> Option<u32> {
    Regex::new(r"\*\*Actionable comments posted: (\d+)\*\*")
        .ok()?
        .captures(body)?
        .get(1)?
        .as_str()
        .parse()
        .ok()
}

fn parse_bugbot_actionable_count(body: &str) -> Option<u32> {
    Regex::new(r"(?is)Cursor Bugbot has reviewed.*?found\s+(\d+)\s+potential issues")
        .ok()?
        .captures(body)?
        .get(1)?
        .as_str()
        .parse()
        .ok()
}

pub fn distill_code_rabbit(body: &str) -> Distilled {
    let mut severity = None;
    if let Some(header) = Regex::new(r"(?m)^[ \t]*_[^_\n]+_(?: \| _[^_\n]+_)+")
        .unwrap()
        .find(body)
    {
        let word_re =
            Regex::new(r"(?i)(?:^|[^a-z])(critical|major|minor|trivial)(?:[^a-z]|$)").unwrap();
        for segment in header.as_str().split('|') {
            if let Some(caps) = word_re.captures(segment) {
                severity = caps.get(1).map(|m| m.as_str().to_lowercase());
            }
        }
    }
    let title = bold_only_line(body).unwrap_or_else(|| first_prose_line(body));
    let detail =
        extract_agent_prompt(body).unwrap_or_else(|| strip_noise(&strip_after_first_details(body)));
    Distilled {
        severity,
        title,
        detail,
    }
}

pub fn distill_codex(body: &str) -> Distilled {
    let severity = Regex::new(r"!\[P(\d) Badge\]")
        .unwrap()
        .captures(body)
        .and_then(|caps| caps.get(1).map(|m| format!("P{}", m.as_str())));
    let title = bold_only_line(body)
        .unwrap_or_default()
        .replace("<sub>", "")
        .replace("</sub>", "");
    let title = Regex::new(r"!\[[^\]]*\]\([^)]*\)")
        .unwrap()
        .replace_all(&title, "")
        .trim()
        .to_string();
    let detail = strip_noise(body)
        .lines()
        .filter(|line| !line.starts_with("**") && !line.starts_with("Useful? React with"))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
    Distilled {
        severity,
        title: if title.is_empty() {
            first_prose_line(body)
        } else {
            title
        },
        detail,
    }
}

pub fn distill_bugbot(body: &str) -> Distilled {
    let title = Regex::new(r"(?m)^###\s+(.+)$")
        .unwrap()
        .captures(body)
        .and_then(|caps| caps.get(1).map(|m| m.as_str().trim().to_string()))
        .unwrap_or_else(|| first_prose_line(body));
    let severity = Regex::new(r"(?im)^\*\*(High|Medium|Low) Severity\*\*$")
        .unwrap()
        .captures(body)
        .and_then(|caps| caps.get(1).map(|m| m.as_str().to_lowercase()));
    let detail = extract_bugbot_description(body)
        .map(|text| strip_noise(&text))
        .unwrap_or_else(|| strip_bugbot_fallback(body));
    Distilled {
        severity,
        title,
        detail,
    }
}

fn bold_only_line(body: &str) -> Option<String> {
    Regex::new(r"(?m)^\*\*(.+?)\*\*$")
        .unwrap()
        .captures(body)?
        .get(1)
        .map(|m| m.as_str().to_string())
}

fn extract_agent_prompt(body: &str) -> Option<String> {
    let marker = body.find("Prompt for AI Agents</summary>")?;
    Regex::new(r"(?s)```[^\n]*\n(.*?)```")
        .unwrap()
        .captures(&body[marker..])?
        .get(1)
        .map(|m| m.as_str().trim().to_string())
}

fn extract_bugbot_description(body: &str) -> Option<String> {
    Regex::new(r"(?s)<!-- DESCRIPTION START -->(.*?)<!-- DESCRIPTION END -->")
        .unwrap()
        .captures(body)?
        .get(1)
        .map(|m| m.as_str().trim().to_string())
}

fn strip_after_first_details(body: &str) -> String {
    body.find("<details>")
        .map_or_else(|| body.to_string(), |index| body[..index].to_string())
}

fn strip_bugbot_fallback(body: &str) -> String {
    let text = strip_noise(body);
    let text = Regex::new(r#"(?s)<div>\s*<a href="https://cursor\.com/open\?.*?</div>"#)
        .unwrap()
        .replace_all(&text, "")
        .to_string();
    Regex::new(r"(?s)<sup>Reviewed by \[Cursor Bugbot\].*?</sup>")
        .unwrap()
        .replace_all(&text, "")
        .replace("\n\n\n", "\n\n")
        .trim()
        .to_string()
}

pub fn strip_noise(body: &str) -> String {
    let mut text = body.to_string();
    while let Some(start) = text.find("<details") {
        let Some(end) = details_block_end(&text, start) else {
            break;
        };
        text.replace_range(start..end, "");
    }
    let text = Regex::new(r"(?s)<!--.*?-->")
        .unwrap()
        .replace_all(&text, "")
        .to_string();
    let text = Regex::new(r"</?(?:sub|blockquote|summary|br)\s*/?>")
        .unwrap()
        .replace_all(&text, "")
        .to_string();
    Regex::new(r"\n{3,}")
        .unwrap()
        .replace_all(&text, "\n\n")
        .trim()
        .to_string()
}

fn details_block_end(text: &str, start: usize) -> Option<usize> {
    let mut position = start;
    let mut depth = 0usize;
    loop {
        let next_open = text[position..]
            .find("<details")
            .map(|index| position + index);
        let next_close = text[position..]
            .find("</details>")
            .map(|index| position + index);
        match (next_open, next_close) {
            (Some(open), Some(close)) if open < close => {
                depth += 1;
                position = open + "<details".len();
            }
            (_, Some(close)) => {
                if depth == 0 {
                    return None;
                }
                depth -= 1;
                position = close + "</details>".len();
                if depth == 0 {
                    return Some(position);
                }
            }
            _ => return None,
        }
    }
}

fn first_prose_line(body: &str) -> String {
    for line in strip_noise(body).lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return trimmed
                .trim_start_matches("**")
                .trim_end_matches("**")
                .to_string();
        }
    }
    "(no title)".to_string()
}

pub fn parse_nitpicks(review_body: &str, bot: &str) -> Vec<Finding> {
    let Some(section_match) = Regex::new(r"(?s)<summary>🧹 Nitpick comments.*")
        .unwrap()
        .find(review_body)
    else {
        return Vec::new();
    };
    let section = section_match.as_str();
    let file_re = Regex::new(r"<summary>([^<(]+?) \(\d+\)</summary>").unwrap();
    let file_matches: Vec<_> = file_re.captures_iter(section).collect();
    let mut findings = Vec::new();
    for (index, caps) in file_matches.iter().enumerate() {
        let full = caps.get(0).unwrap();
        let end = file_matches
            .get(index + 1)
            .and_then(|c| c.get(0))
            .map_or(section.len(), |m| m.start());
        let path = caps.get(1).unwrap().as_str().trim();
        findings.extend(parse_nitpick_entries(&section[full.end()..end], path, bot));
    }
    findings
}

fn parse_nitpick_entries(block: &str, path: &str, bot: &str) -> Vec<Finding> {
    let entry_re = Regex::new(r"`(\d+(?:-\d+)?)`:").unwrap();
    let entries: Vec<_> = entry_re.captures_iter(block).collect();
    entries
        .iter()
        .enumerate()
        .map(|(index, caps)| {
            let full = caps.get(0).unwrap();
            let end = entries
                .get(index + 1)
                .and_then(|c| c.get(0))
                .map_or(block.len(), |m| m.start());
            let distilled = distill_code_rabbit(&block[full.end()..end]);
            Finding {
                path: path.to_string(),
                line: caps.get(1).unwrap().as_str().to_string(),
                bot: bot.to_string(),
                severity: distilled.severity,
                title: distilled.title,
                detail: distilled.detail,
                resolved: false,
                outdated: false,
            }
        })
        .collect()
}
