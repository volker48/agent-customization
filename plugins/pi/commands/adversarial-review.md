---
description: Ask read-only Pi to adversarially review the current diff or target branch
argument-hint: "--wait [--model provider/model] [--target ref] [review context]"
---

Collect git status/diff context in Claude Code, then send that prompt text to a read-only Pi RPC
session framed to challenge assumptions, design tradeoffs, failure modes, simpler alternatives,
race conditions, rollback risk, and data-loss risk. Flags are parsed from stdin safely:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" adversarial-review --wait <<'PI_REVIEW_BRIEF'
$ARGUMENTS
PI_REVIEW_BRIEF
```

Report the Pi review job id, session metadata, findings, and any truncation notes. Do not edit
files while running the review.
