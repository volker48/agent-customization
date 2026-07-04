---
description: Show the stored result and audit evidence for a Pi implementation job
argument-hint: "[job-id|latest]"
---

Run the result command from the current project. The selector goes through stdin instead of shell
interpolation and defaults to `latest`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" result <<'PI_RESULT_SELECTOR'
$ARGUMENTS
PI_RESULT_SELECTOR
```

Report the job status, final output, changed files, test evidence, Pi session reference, and log path.
Do not edit files while inspecting Pi job results.
