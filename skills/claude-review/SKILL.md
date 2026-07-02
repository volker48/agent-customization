---
name: claude-review
description: Runs an independent Claude Code /code-review from the current repository and turns findings into actionable fixes. Use when the user asks for a Claude review, second-opinion review, /code-review, or after non-trivial code changes where an external review could catch correctness, security, or integration issues.
---

# Claude Review

## Quick start

From this skill directory, run:

```bash
./scripts/run-claude-review.sh medium "review the current diff for correctness bugs"
```

From this repository checkout, humans can run:

```bash
skills/claude-review/scripts/run-claude-review.sh high "review the current branch"
```

If the Pi `claude-review` extension is installed, prefer a durable background review:

```text
/claude-review high review the current branch
/claude-review-status
/claude-review-result --no-fix
```

Use the legacy blocking path only when the caller explicitly wants to wait in-place:

```text
/claude-review --wait high review the current branch
```

## Workflow

1. Use this skill only when an independent Claude Code review is useful: requested by the
   user, after non-trivial edits, or before finalizing risky correctness/security work.
2. Pick a review level:
   - `low`: fastest check for quick smoke reviews.
   - `medium`: default for normal code changes.
   - `high`: bug fixes, security-sensitive code, or cross-file behavior changes.
   - `max`: substantial or high-risk changes where extra review cost is justified.
   - Do not use `ultra`; headless Claude review runs do not support it.
3. If the Pi extension is installed, start the review in the background so Pi/Codex does not
   wait on a long-running subprocess:

```text
/claude-review high review the current diff for correctness and edge cases
```

Then retrieve it later:

```text
/claude-review-status
/claude-review-result --no-fix
```

4. If the extension is not available, run Claude Code from the target repository root with
   focused context:

```bash
claude --permission-mode auto \
  --allowed-tools "Bash,Read,Glob,Grep,LSP,WebFetch,WebSearch,Skill" \
  -p "/code-review high review the current diff for correctness and edge cases"
```

Headless Claude review can take several minutes to complete. Do not treat a quiet run as
failed unless the process exits with an error or clearly hangs beyond a reasonable timeout.

5. Read the review and act only on high-confidence, actionable findings.
6. Ignore speculative, stylistic, or out-of-scope suggestions unless the user asked for them.
7. After making fixes, run the relevant formatter, type checker, and focused tests.
8. Report what Claude found, what you changed, and what verification passed.

## Pi extension commands

- `/claude-review [--background|--wait] [--fix|--no-fix] [low|medium|high|max] [context]`
  starts a durable background job by default. `--wait` keeps the old blocking `claude -p` path.
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
