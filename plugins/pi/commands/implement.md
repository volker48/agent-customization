---
description: Delegate an implementation brief to Pi over RPC and wait for the result
argument-hint: "--wait [--model provider/model] <implementation brief>"
---

Run the write-capable Pi implementation delegate from the current project. The companion parses
leading `--wait` and `--model provider/model` flags from stdin, so the implementation brief still
goes through stdin instead of shell interpolation:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" implement --wait <<'PI_IMPLEMENT_BRIEF'
$ARGUMENTS
PI_IMPLEMENT_BRIEF
```

Report the resulting job id, Pi session metadata, final implementation summary, and any failed
checks to the user. Do not edit files on the Claude side while Pi is implementing.
