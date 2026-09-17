---
name: claude-review
description: Runs an independent Claude Code review from the current repository and turns findings into actionable fixes. Use when the user asks for a Claude review, second-opinion review, /code-review, or after non-trivial code changes where an external review could catch correctness, security, or integration issues.
disable-model-invocation: true
---

# Claude Review

## Quick start

Keep the process working directory at the target repository root. Never `cd` to this skill's directory. If the Pi `claude_review` tool is available, use it to start and manage a durable background review:

```json
{"action":"start","level":"high","context":"review the current branch"}
```

```json
{"action":"status"}
```

```json
{"action":"result","autoFix":false}
```

If the tool is unavailable, resolve this skill's loaded absolute directory and execute its helper while remaining in the target repository:

```bash
/path/to/loaded/claude-review/scripts/run-claude-review.sh medium "review the current diff for correctness bugs"
```

From this customization checkout, the equivalent human command is:

```bash
skills/claude-review/scripts/run-claude-review.sh high "review the current branch"
```

Use `mode: "wait"` only when the caller explicitly wants to block until the review finishes.

## Workflow

1. Use this skill only when an independent Claude Code review is useful: requested by the
   user, after non-trivial edits, or before finalizing risky correctness/security work.
2. Pick a review level:
   - `low`: fastest check for quick smoke reviews.
   - `medium`: default for normal code changes.
   - `high`: bug fixes, security-sensitive code, or cross-file behavior changes.
   - `max`: substantial or high-risk changes where extra review cost is justified.
   - Do not use `ultra`; headless Claude review runs do not support it.
3. If the Pi extension is installed, call `claude_review` with `action: "start"`. Use the
   returned job id with `action: "status"` and `action: "result"`. Tool operations execute
   directly and sequentially; writing slash-command text in an agent response does not execute it.
4. If the extension is unavailable, run the bundled helper from the target repository root.
   The helper supplies the explicit review contract, effort, available tool set, and permission
   allowlist. Headless review can take several minutes; a quiet process is not a failure unless
   it exits unsuccessfully or exceeds a reasonable timeout.

5. Read the review and act only on high-confidence, actionable findings.
6. Ignore speculative, stylistic, or out-of-scope suggestions unless the user asked for them.
7. After making fixes, run the relevant formatter, type checker, and focused tests.
8. Report what Claude found, what you changed, and what verification passed.

## Pi extension interface

Agents use the `claude_review` tool with actions `start`, `status`, `result`, `logs`, `cancel`,
or `list`. Humans may use the matching slash commands:

- `/claude-review [--background|--wait] [--fix|--no-fix] [low|medium|high|max] [context]`
  starts a durable background job by default. `--wait` uses blocking `claude -p`.
- `/claude-review-status [job-id]` refreshes job state from `claude agents --json --all`.
- `/claude-review-result [job-id] [--fix|--no-fix]` fetches `claude logs <id>` output. If
  neither flag is provided, it uses the job's stored auto-fix preference.
- `/claude-review-logs [job-id]` shows recent Claude logs without sending an auto-fix prompt.
- `/claude-review-cancel [job-id]` stops the Claude background session.
- `/claude-review-list [--all]` lists saved jobs. Without `--all`, it shows jobs for the
  current working directory.

## Failure handling

- If `claude` is unavailable, try `PI_CLAUDE_REVIEW_BIN=/path/to/claude` or report the blocker.
- Background job state is stored under `~/.pi/agent/claude-review/jobs`. Override with
  `PI_CLAUDE_REVIEW_JOB_DIR=/path/to/jobs` when needed.
- If Claude returns no findings or no output, make no extra changes unless you independently
  identify an issue.
- Avoid review loops. Do not repeatedly re-run Claude review after every small fix unless the
  user explicitly asks or the fix materially changes the reviewed code.
