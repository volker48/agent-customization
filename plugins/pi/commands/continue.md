---
description: Continue a previous Pi implementation job in its stored Pi session
argument-hint: "[job-id|latest] <instruction>"
---

Run the write-capable Pi implementation delegate from the selected previous job's stored Pi
session. The selector and instruction go through stdin instead of shell interpolation. The selector
defaults to `latest` when the first token is not a job selector:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" continue --wait <<'PI_CONTINUE_INSTRUCTION'
$ARGUMENTS
PI_CONTINUE_INSTRUCTION
```

Report the linked continuation job id, parent/root job metadata, Pi session reference, final output,
changed files, and test evidence. Do not edit files on the Claude side while Pi is continuing.
