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

If the Pi `claude-review` extension is installed, humans may also use:

```text
/claude-review high review the current branch
```

## Workflow

1. Use this skill only when an independent Claude Code review is useful: requested by the
   user, after non-trivial edits, or before finalizing risky correctness/security work.
2. Pick a review level:
   - `medium`: default for normal code changes.
   - `high`: bug fixes, security-sensitive code, or cross-file behavior changes.
   - `max`: substantial or high-risk changes where extra review cost is justified.
   - Do not use `ultra`; headless Claude review runs do not support it.
3. Run Claude Code from the target repository root with focused context:

```bash
claude --permission-mode auto \
  --allowed-tools "Bash,Read,Glob,Grep,LSP,WebFetch,WebSearch,Skill" \
  -p "/code-review high review the current diff for correctness and edge cases"
```

4. Read the review and act only on high-confidence, actionable findings.
5. Ignore speculative, stylistic, or out-of-scope suggestions unless the user asked for them.
6. After making fixes, run the relevant formatter, type checker, and focused tests.
7. Report what Claude found, what you changed, and what verification passed.

## Failure handling

- If `claude` is unavailable, try `PI_CLAUDE_REVIEW_BIN=/path/to/claude` or report the blocker.
- If Claude returns no findings or no output, make no extra changes unless you independently
  identify an issue.
- Avoid review loops. Do not repeatedly re-run Claude review after every small fix unless the
  user explicitly asks or the fix materially changes the reviewed code.
