---
description: Ask an ephemeral read-only Pi RPC session to review the current diff or target branch
argument-hint: "--wait [--model provider/model] [--target ref] [review context]"
---

Collect git status/diff context in Claude Code, then send that prompt text to a read-only Pi RPC
review session. The companion parses leading flags from stdin instead of interpolating shell text:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" review --wait <<'PI_REVIEW_BRIEF'
$ARGUMENTS
PI_REVIEW_BRIEF
```

Report the Pi review job id, session metadata, findings, and any truncation notes. Do not edit
files while running the review.
