---
description: Delegate an implementation brief to Pi over RPC
argument-hint: "(--wait|--background) [--model provider/model] <implementation brief>"
---

Run the write-capable Pi implementation delegate from the current project. The companion parses
leading `--wait`, `--background`, and `--model provider/model` flags from stdin, so the
implementation brief still goes through stdin instead of shell interpolation.

Both `--wait` and `--background` are typed as part of `$ARGUMENTS`; they are not separate
CLI flags in this command template.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" implement <<'PI_IMPLEMENT_BRIEF'
$ARGUMENTS
PI_IMPLEMENT_BRIEF
```

For `--background`, report the job id and tell the user to use `/pi:status`, `/pi:result`, or
`/pi:cancel`. For `--wait`, report the Pi session metadata, final implementation summary, and
any failed checks. Do not edit files on the Claude side while Pi is implementing.

Pi implementation runs can take up to 30 minutes, which exceeds the Bash tool's foreground
timeout. For anything beyond a small brief, either run the `--wait` command with
`run_in_background` or use `--background` and poll `/pi:status` until the job finishes.
