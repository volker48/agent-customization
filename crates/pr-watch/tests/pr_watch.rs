use serde_json::{Value, json};

use pr_watch::bots::{adapter_for_login, distill_comment, parse_nitpicks};
use pr_watch::core::{
    BotReview, CheckState, Finding, PrCheck, PrSnapshot, SettleOptions, SettleResult,
    evaluate_settled, exit_code_for, hoist_shared_preamble, render_findings, render_status,
    unresolved_findings,
};
use pr_watch::forge::collect_json_pages;
use pr_watch::github::{REVIEW_QUERY, parse_pr_view, parse_review_data};
use pr_watch::gitlab::{
    parse_gitlab_bot_reviews, parse_gitlab_findings, parse_gitlab_jobs, parse_gitlab_mr,
};

fn fixture(name: &str) -> String {
    std::fs::read_to_string(format!("tests/fixtures/{name}")).unwrap()
}

fn fixture_json(name: &str) -> Value {
    serde_json::from_str(&fixture(name)).unwrap()
}

fn snapshot_with(mut overrides: PrSnapshot) -> PrSnapshot {
    let mut base = parse_pr_view(&fixture_json("pr-view.json")).unwrap();
    base.number = overrides.number;
    base.title = std::mem::take(&mut overrides.title);
    if !overrides.state.is_empty() {
        base.state = overrides.state;
    }
    base.is_draft = overrides.is_draft;
    if !overrides.head_ref_name.is_empty() {
        base.head_ref_name = overrides.head_ref_name;
    }
    if !overrides.base_ref_name.is_empty() {
        base.base_ref_name = overrides.base_ref_name;
    }
    if !overrides.head_oid.is_empty() {
        base.head_oid = overrides.head_oid;
    }
    base.head_committed_at = overrides.head_committed_at;
    if !overrides.owner.is_empty() {
        base.owner = overrides.owner;
    }
    if !overrides.repo.is_empty() {
        base.repo = overrides.repo;
    }
    if !overrides.checks.is_empty() {
        base.checks = overrides.checks;
    }
    if !overrides.bot_reviews.is_empty() {
        base.bot_reviews = overrides.bot_reviews;
    }
    if !overrides.findings.is_empty() {
        base.findings = overrides.findings;
    }
    base
}

fn empty_snapshot() -> PrSnapshot {
    PrSnapshot {
        number: 63,
        title: String::new(),
        state: String::new(),
        is_draft: false,
        head_ref_name: String::new(),
        base_ref_name: String::new(),
        head_oid: String::new(),
        head_committed_at: None,
        owner: String::new(),
        repo: String::new(),
        checks: Vec::new(),
        bot_reviews: Vec::new(),
        findings: Vec::new(),
    }
}

fn finding_with(overrides: Finding) -> Finding {
    Finding {
        path: if overrides.path.is_empty() {
            "src/a.ts".into()
        } else {
            overrides.path
        },
        line: if overrides.line.is_empty() {
            "1".into()
        } else {
            overrides.line
        },
        bot: if overrides.bot.is_empty() {
            "coderabbit".into()
        } else {
            overrides.bot
        },
        severity: overrides.severity.or_else(|| Some("major".into())),
        title: if overrides.title.is_empty() {
            "A title".into()
        } else {
            overrides.title
        },
        detail: if overrides.detail.is_empty() {
            "Shared preamble.\n\nSpecific fix instructions.".into()
        } else {
            overrides.detail
        },
        resolved: overrides.resolved,
        outdated: overrides.outdated,
    }
}

fn empty_finding() -> Finding {
    Finding {
        path: String::new(),
        line: String::new(),
        bot: String::new(),
        severity: None,
        title: String::new(),
        detail: String::new(),
        resolved: false,
        outdated: false,
    }
}

fn gitlab_discussion(path: &str, line: u64, title: &str) -> Value {
    json!({"notes":[{"body": format!("### {title}\n\n**Low Severity**\n\n<!-- DESCRIPTION START -->\nPaged discussion detail.\n<!-- DESCRIPTION END -->"), "resolvable": true, "resolved": false, "created_at": "2026-07-06T13:00:00Z", "author": {"username": "cursor"}, "position": {"new_path": path, "new_line": line}}]})
}

#[test]
fn review_query_paginates_review_threads() {
    assert!(REVIEW_QUERY.contains("$reviewThreadsCursor: String"));
    assert!(REVIEW_QUERY.contains("reviewThreads(first: 100, after: $reviewThreadsCursor)"));
    assert!(REVIEW_QUERY.contains("hasNextPage"));
    assert!(REVIEW_QUERY.contains("endCursor"));
}

#[test]
fn parse_pr_view_parses_real_payload() {
    let snapshot = parse_pr_view(&fixture_json("pr-view.json")).unwrap();
    assert_eq!(snapshot.number, 63);
    assert_eq!(snapshot.owner, "volker48");
    assert_eq!(snapshot.repo, "agent-customization");
    assert_eq!(snapshot.head_ref_name, "github-repo-orientation");
    assert_eq!(snapshot.head_oid.len(), 40);
    assert!(snapshot.head_committed_at.unwrap().ends_with('Z'));
}

#[test]
fn parse_pr_view_maps_check_run_and_status_context_states() {
    let snapshot = parse_pr_view(&fixture_json("pr-view.json")).unwrap();
    assert_eq!(snapshot.checks.len(), 3);
    assert!(
        snapshot
            .checks
            .iter()
            .all(|check| check.state == CheckState::Passed)
    );
    assert!(
        snapshot
            .checks
            .iter()
            .any(|check| check.name == "CodeRabbit")
    );
}

#[test]
fn parse_pr_view_maps_pending_and_failed_states() {
    let mut raw = fixture_json("pr-view.json");
    raw["statusCheckRollup"] = json!([
        {"__typename":"CheckRun","name":"build","status":"IN_PROGRESS","conclusion":null},
        {"__typename":"StatusContext","context":"CodeRabbit","state":"PENDING"},
        {"__typename":"CheckRun","name":"lint","status":"COMPLETED","conclusion":"FAILURE"}
    ]);
    let states: Vec<_> = parse_pr_view(&raw)
        .unwrap()
        .checks
        .into_iter()
        .map(|check| check.state)
        .collect();
    assert_eq!(
        states,
        [CheckState::Pending, CheckState::Pending, CheckState::Failed]
    );
}

#[test]
fn coderabbit_extracts_severity_title_and_prompt_block() {
    let distilled = distill_comment(
        "coderabbitai[bot]",
        &fixture("coderabbit-inline-comment.md"),
    );
    assert_eq!(distilled.severity.as_deref(), Some("major"));
    assert!(distilled.title.contains("active statuses"));
    assert!(distilled.detail.contains("Consolidate the"));
    assert!(distilled.detail.contains("ACTIVE_JOB_STATUSES"));
}

#[test]
fn coderabbit_drops_html_noise() {
    let detail = distill_comment(
        "coderabbitai[bot]",
        &fixture("coderabbit-inline-comment.md"),
    )
    .detail;
    assert!(!detail.contains("<details>"));
    assert!(!detail.contains("<!--"));
    assert!(!detail.contains("Committable suggestion"));
    assert!(!detail.contains("fingerprinting"));
}

#[test]
fn coderabbit_falls_back_to_stripped_prose() {
    let body = "_⚠️ Potential issue_ | _🔴 Critical_\n\n**Bad bug.**\n\nProse here.\n\n<details><summary>x</summary>noise</details>\n<!-- meta -->";
    let distilled = distill_comment("coderabbitai", body);
    assert_eq!(distilled.severity.as_deref(), Some("critical"));
    assert_eq!(distilled.title, "Bad bug.");
    assert!(distilled.detail.contains("Prose here."));
    assert!(!distilled.detail.contains("noise"));
}

#[test]
fn codex_extracts_p_severity_badge_free_title_and_detail() {
    let distilled = distill_comment(
        "chatgpt-codex-connector[bot]",
        &fixture("codex-inline-comment.md"),
    );
    assert_eq!(distilled.severity.as_deref(), Some("P2"));
    assert_eq!(
        distilled.title,
        "Do not report cancelling review races as completed"
    );
    assert!(distilled.detail.contains("executeReview"));
    assert!(!distilled.detail.contains("Badge"));
    assert!(!distilled.detail.contains("Useful? React"));
}

#[test]
fn bugbot_extracts_title_severity_detail_and_actionable_count() {
    let distilled = distill_comment("cursor[bot]", &fixture("bugbot-inline-comment.md"));
    assert_eq!(distilled.severity.as_deref(), Some("high"));
    assert_eq!(distilled.title, "gh no-PR errors misclassified");
    assert!(
        distilled
            .detail
            .contains("no open pull requests found for branch")
    );
    assert!(!distilled.detail.contains("cursor.com/open"));
    assert!(!distilled.detail.contains("Reviewed by [Cursor Bugbot]"));
    assert!(!distilled.detail.contains("LOCATIONS START"));
    assert_eq!(
        adapter_for_login("cursor[bot]", &[])
            .unwrap()
            .actionable_count(&fixture("bugbot-review-body.md")),
        Some(3)
    );
}

#[test]
fn parse_nitpicks_parses_real_review_body() {
    let nitpicks = parse_nitpicks(&fixture("coderabbit-review-body.md"), "coderabbit");
    assert_eq!(nitpicks.len(), 2);
    assert_eq!(nitpicks[0].path, "tests/claude-pi-jobs.test.ts");
    assert_eq!(nitpicks[0].line, "42-54");
    assert_eq!(nitpicks[0].severity.as_deref(), Some("trivial"));
    assert_eq!(nitpicks[1].path, "plugins/pi/scripts/lib/cancel.mjs");
    assert!(!nitpicks[1].detail.contains("<details>"));
}

#[test]
fn parse_nitpicks_returns_empty_without_section() {
    assert!(parse_nitpicks("**Actionable comments posted: 0**", "coderabbit").is_empty());
}

fn review_graphql() -> Value {
    json!({"data":{"repository":{"pullRequest":{"reviews":{"nodes":[
        {"author":{"login":"coderabbitai"},"state":"COMMENTED","submittedAt":"2026-07-05T10:00:00Z","body":fixture("coderabbit-review-body.md"),"commit":{"oid":"abc123"}},
        {"author":{"login":"volker48"},"state":"APPROVED","submittedAt":"2026-07-05T11:00:00Z","body":"","commit":null}
    ]},"reviewThreads":{"nodes":[
        {"isResolved":false,"isOutdated":false,"path":"plugins/pi/scripts/lib/jobs.mjs","line":23,"startLine":16,"comments":{"nodes":[{"author":{"login":"coderabbitai"},"body":fixture("coderabbit-inline-comment.md")}]}},
        {"isResolved":true,"isOutdated":false,"path":"pi-extensions/claude-review/claude-bg.ts","line":410,"startLine":null,"comments":{"nodes":[{"author":{"login":"chatgpt-codex-connector"},"body":fixture("codex-inline-comment.md")}]}},
        {"isResolved":false,"isOutdated":false,"path":"README.md","line":1,"startLine":null,"comments":{"nodes":[{"author":{"login":"volker48"},"body":"human comment"}]}}
    ],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}})
}

#[test]
fn parse_review_data_keeps_bot_reviews_and_drops_humans() {
    let bots = [
        "coderabbitai".to_string(),
        "chatgpt-codex-connector".to_string(),
    ];
    let data = parse_review_data(&review_graphql(), &bots);
    assert_eq!(data.bot_reviews.len(), 1);
    assert_eq!(data.bot_reviews[0].bot, "coderabbit");
    assert_eq!(data.bot_reviews[0].actionable, Some(1));
    assert_eq!(data.bot_reviews[0].commit_oid.as_deref(), Some("abc123"));
    assert_eq!(data.nitpicks.len(), 2);
}

#[test]
fn parse_review_data_turns_bot_threads_into_findings() {
    let bots = [
        "coderabbitai".to_string(),
        "chatgpt-codex-connector".to_string(),
    ];
    let data = parse_review_data(&review_graphql(), &bots);
    assert_eq!(data.findings.len(), 2);
    assert_eq!(data.findings[0].path, "plugins/pi/scripts/lib/jobs.mjs");
    assert_eq!(data.findings[0].line, "16-23");
    assert_eq!(data.findings[0].bot, "coderabbit");
    assert_eq!(data.findings[1].bot, "codex");
    assert!(data.findings[1].resolved);
}

#[test]
fn parse_review_data_respects_configured_bot_list() {
    let data = parse_review_data(&review_graphql(), &["chatgpt-codex-connector".to_string()]);
    assert!(data.bot_reviews.is_empty());
    assert_eq!(data.findings.len(), 1);
    assert_eq!(data.findings[0].bot, "codex");
}

#[test]
fn gitlab_parses_mr_shape_state_project_and_pipeline() {
    let parsed = parse_gitlab_mr(&fixture_json("gitlab-mr-open.json"));
    assert_eq!(parsed.project_id, "1234");
    assert_eq!(parsed.pipeline_id.as_deref(), Some("9876"));
    assert_eq!(parsed.host, "gitlab.example.com");
    assert_eq!(parsed.snapshot.number, 42);
    assert_eq!(parsed.snapshot.state, "OPEN");
    assert_eq!(parsed.snapshot.owner, "group/subgroup");
    assert_eq!(parsed.snapshot.repo, "project");
}

#[test]
fn gitlab_maps_job_statuses() {
    let states: Vec<_> = parse_gitlab_jobs(&fixture_json("gitlab-jobs.json"))
        .into_iter()
        .map(|check| check.state)
        .collect();
    assert_eq!(
        states,
        [
            CheckState::Passed,
            CheckState::Failed,
            CheckState::Skipped,
            CheckState::Pending,
            CheckState::Skipped,
            CheckState::Failed
        ]
    );
}

#[test]
fn gitlab_turns_bot_discussions_into_findings() {
    let values = fixture_json("gitlab-discussions.json")
        .as_array()
        .unwrap()
        .clone();
    let findings = parse_gitlab_findings(&values, &["cursor".to_string()]);
    assert_eq!(findings.len(), 2);
    assert_eq!(findings[0].path, "src/gitlab.ts");
    assert_eq!(findings[0].line, "27");
    assert_eq!(findings[0].bot, "bugbot");
    assert_eq!(findings[0].severity.as_deref(), Some("medium"));
    assert!(!findings[0].resolved && !findings[0].outdated);
    assert_eq!(findings[1].path, "src/old.ts");
    assert!(findings[1].resolved);
}

#[test]
fn gitlab_combines_multi_page_discussions() {
    let pages = [
        vec![
            gitlab_discussion("src/first.ts", 10, "First"),
            json!({"notes":[{"body":"human","resolvable":true,"resolved":false,"created_at":"2026-07-06T13:00:00Z","author":{"username":"human"},"position":{"new_path":"src/human.ts","new_line":1}}]}),
        ],
        vec![gitlab_discussion("src/second.ts", 20, "Second")],
    ];
    let discussions = collect_json_pages(
        |page, _| Value::Array(pages.get(page - 1).cloned().unwrap_or_default()),
        "gitlab discussions",
        2,
    )
    .unwrap();
    let paths: Vec<_> = parse_gitlab_findings(&discussions, &["cursor".to_string()])
        .into_iter()
        .map(|f| f.path)
        .collect();
    assert_eq!(paths, ["src/first.ts", "src/second.ts"]);
}

#[test]
fn gitlab_skips_discussions_without_concrete_position() {
    let mut discussion = gitlab_discussion("src/first.ts", 10, "First");
    discussion["notes"][0]
        .as_object_mut()
        .unwrap()
        .remove("position");
    assert!(parse_gitlab_findings(&[discussion], &["cursor".to_string()]).is_empty());
}

#[test]
fn gitlab_synthesizes_bot_reviews_from_top_level_notes() {
    let values = fixture_json("gitlab-discussions.json")
        .as_array()
        .unwrap()
        .clone();
    let reviews = parse_gitlab_bot_reviews(&values, &["cursor".to_string()]);
    assert_eq!(
        reviews,
        [BotReview {
            bot: "bugbot".into(),
            submitted_at: "2026-07-06T14:00:00Z".into(),
            commit_oid: None,
            actionable: Some(2)
        }]
    );
}

#[test]
fn merged_gitlab_mrs_settle_unconditionally() {
    let parsed = parse_gitlab_mr(&fixture_json("gitlab-mr-merged.json"));
    assert!(evaluate_settled(&parsed.snapshot, &SettleOptions::default()).settled);
}

#[test]
fn hoists_identical_first_paragraph() {
    let (preamble, hoisted) = hoist_shared_preamble(&[
        finding_with(empty_finding()),
        finding_with(Finding {
            detail: "Shared preamble.\n\nOther fix.".into(),
            ..empty_finding()
        }),
    ]);
    assert_eq!(preamble.as_deref(), Some("Shared preamble."));
    assert_eq!(hoisted[0].detail, "Specific fix instructions.");
    assert_eq!(hoisted[1].detail, "Other fix.");
}

#[test]
fn hoists_nothing_for_different_or_single_preambles() {
    let (preamble, _) = hoist_shared_preamble(&[
        finding_with(empty_finding()),
        finding_with(Finding {
            detail: "Different.\n\nFix.".into(),
            ..empty_finding()
        }),
    ]);
    assert!(preamble.is_none());
    let (single, _) = hoist_shared_preamble(&[finding_with(empty_finding())]);
    assert!(single.is_none());
}

fn base_settle_snapshot() -> PrSnapshot {
    snapshot_with(PrSnapshot {
        state: "OPEN".into(),
        head_oid: "feedface00000000000000000000000000000000".into(),
        head_committed_at: Some("2026-07-06T12:00:00Z".into()),
        checks: vec![PrCheck {
            name: "ci".into(),
            state: CheckState::Passed,
        }],
        ..empty_snapshot()
    })
}

#[test]
fn evaluate_settled_blocks_on_pending_checks() {
    let mut snapshot = base_settle_snapshot();
    snapshot.checks = vec![PrCheck {
        name: "CodeRabbit".into(),
        state: CheckState::Pending,
    }];
    snapshot.bot_reviews = vec![BotReview {
        bot: "coderabbit".into(),
        submitted_at: "2026-07-06T13:00:00Z".into(),
        commit_oid: None,
        actionable: Some(0),
    }];
    let settle = evaluate_settled(&snapshot, &SettleOptions::default());
    assert!(!settle.settled);
    assert_eq!(settle.checks_pending, 1);
}

#[test]
fn evaluate_settled_requires_current_bot_review() {
    let mut stale = base_settle_snapshot();
    stale.bot_reviews = vec![BotReview {
        bot: "coderabbit".into(),
        submitted_at: "2026-07-06T11:00:00Z".into(),
        commit_oid: Some("old".into()),
        actionable: Some(0),
    }];
    assert!(!evaluate_settled(&stale, &SettleOptions::default()).review_landed);
    let mut by_time = base_settle_snapshot();
    by_time.bot_reviews = vec![BotReview {
        bot: "coderabbit".into(),
        submitted_at: "2026-07-06T12:30:00Z".into(),
        commit_oid: Some("old".into()),
        actionable: Some(0),
    }];
    assert!(evaluate_settled(&by_time, &SettleOptions::default()).settled);
    let mut by_oid = base_settle_snapshot();
    by_oid.bot_reviews = vec![BotReview {
        bot: "codex".into(),
        submitted_at: "2026-07-06T09:00:00Z".into(),
        commit_oid: Some(by_oid.head_oid.clone()),
        actionable: None,
    }];
    assert!(evaluate_settled(&by_oid, &SettleOptions::default()).settled);
}

#[test]
fn evaluate_settled_settles_on_checks_alone_with_no_reviews() {
    let snapshot = base_settle_snapshot();
    assert!(!evaluate_settled(&snapshot, &SettleOptions::default()).settled);
    assert!(
        evaluate_settled(
            &snapshot,
            &SettleOptions {
                no_reviews: true,
                bots: vec![]
            }
        )
        .settled
    );
}

#[test]
fn evaluate_settled_counts_bot_named_check_as_review_signal() {
    let mut snapshot = base_settle_snapshot();
    snapshot.checks.push(PrCheck {
        name: "CodeRabbit".into(),
        state: CheckState::Passed,
    });
    let settle = evaluate_settled(&snapshot, &SettleOptions::default());
    assert!(settle.settled && settle.review_landed);
    assert!(
        !evaluate_settled(
            &snapshot,
            &SettleOptions {
                no_reviews: false,
                bots: vec!["chatgpt-codex-connector".into()]
            }
        )
        .settled
    );
}

#[test]
fn evaluate_settled_treats_merged_and_closed_as_settled() {
    let mut merged = base_settle_snapshot();
    merged.state = "MERGED".into();
    merged.checks = vec![PrCheck {
        name: "ci".into(),
        state: CheckState::Pending,
    }];
    assert!(evaluate_settled(&merged, &SettleOptions::default()).settled);
    merged.state = "CLOSED".into();
    assert!(evaluate_settled(&merged, &SettleOptions::default()).settled);
}

#[test]
fn exit_code_for_maps_snapshot_state() {
    let settled = SettleResult {
        settled: true,
        checks_pending: 0,
        review_landed: true,
    };
    assert_eq!(exit_code_for(&snapshot_with(empty_snapshot()), &settled), 0);
    assert_eq!(
        exit_code_for(
            &snapshot_with(empty_snapshot()),
            &SettleResult {
                settled: false,
                ..settled.clone()
            }
        ),
        3
    );
    assert_eq!(
        exit_code_for(
            &snapshot_with(PrSnapshot {
                findings: vec![finding_with(empty_finding())],
                ..empty_snapshot()
            }),
            &settled
        ),
        1
    );
    assert_eq!(
        exit_code_for(
            &snapshot_with(PrSnapshot {
                checks: vec![PrCheck {
                    name: "ci".into(),
                    state: CheckState::Failed
                }],
                ..empty_snapshot()
            }),
            &settled
        ),
        2
    );
    assert_eq!(
        exit_code_for(
            &snapshot_with(PrSnapshot {
                checks: vec![PrCheck {
                    name: "ci".into(),
                    state: CheckState::Failed
                }],
                findings: vec![finding_with(empty_finding())],
                ..empty_snapshot()
            }),
            &settled
        ),
        2
    );
}

#[test]
fn exit_code_ignores_resolved_and_outdated_findings() {
    let settled = SettleResult {
        settled: true,
        checks_pending: 0,
        review_landed: true,
    };
    let snapshot = snapshot_with(PrSnapshot {
        findings: vec![
            finding_with(Finding {
                resolved: true,
                ..empty_finding()
            }),
            finding_with(Finding {
                outdated: true,
                ..empty_finding()
            }),
        ],
        ..empty_snapshot()
    });
    assert!(unresolved_findings(&snapshot).is_empty());
    assert_eq!(exit_code_for(&snapshot, &settled), 0);
}

#[test]
fn rendering_status_ends_in_machine_stable_summary_line() {
    let snapshot = snapshot_with(PrSnapshot {
        findings: vec![finding_with(empty_finding())],
        bot_reviews: vec![BotReview {
            bot: "coderabbit".into(),
            submitted_at: "2026-07-06T12:30:00Z".into(),
            commit_oid: Some("abc123".into()),
            actionable: Some(1),
        }],
        ..empty_snapshot()
    });
    let text = render_status(
        &snapshot,
        &SettleResult {
            settled: true,
            checks_pending: 0,
            review_landed: true,
        },
        None,
    );
    let lines: Vec<_> = text.lines().collect();
    assert!(lines[0].contains("PR #63 github-repo-orientation → main [MERGED]"));
    assert_eq!(lines.last().unwrap(), &"SETTLED findings=1 checks=3/3");
    assert!(text.contains("review coderabbit @abc123 actionable=1"));
}

#[test]
fn rendering_labels_timeout_and_reports_failures() {
    let snapshot = snapshot_with(PrSnapshot {
        checks: vec![PrCheck {
            name: "ci".into(),
            state: CheckState::Failed,
        }],
        ..empty_snapshot()
    });
    let text = render_status(
        &snapshot,
        &SettleResult {
            settled: false,
            checks_pending: 0,
            review_landed: false,
        },
        Some("TIMEOUT"),
    );
    assert_eq!(
        text.lines().last().unwrap(),
        "TIMEOUT findings=0 checks=0/1 failed=1"
    );
}

#[test]
fn rendering_findings_hoists_preamble_and_severity_tags() {
    let findings = vec![
        finding_with(empty_finding()),
        finding_with(Finding {
            path: "b.ts".into(),
            line: "410".into(),
            bot: "codex".into(),
            severity: Some("P2".into()),
            title: "Codex title".into(),
            detail: "Shared preamble.\n\nCodex fix.".into(),
            ..empty_finding()
        }),
    ];
    let text = render_findings(&findings, "findings");
    assert!(text.contains("findings (2):"));
    assert!(text.contains("reviewer instruction: Shared preamble."));
    assert!(text.contains("1. src/a.ts:1 [coderabbit major]"));
    assert!(text.contains("2. b.ts:410 [codex P2]"));
    assert!(text.contains("   Codex fix."));
    assert_eq!(text.matches("Shared preamble.").count(), 1);
}

#[test]
fn rendering_empty_findings_marker() {
    assert_eq!(render_findings(&[], "findings"), "findings: none");
}
