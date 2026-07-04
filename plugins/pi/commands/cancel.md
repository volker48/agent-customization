---
description: Cancel an active Pi implementation job
argument-hint: "[job-id|latest]"
---

Run the cancel command from the current project. The selector goes through stdin instead of shell
interpolation and defaults to `latest`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" cancel <<'PI_CANCEL_SELECTOR'
$ARGUMENTS
PI_CANCEL_SELECTOR
```

Report whether the job is cancelling or cancelled, and mention `/pi:status` or `/pi:result <job-id>`
for follow-up details.
