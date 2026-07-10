# Pi subagent customizations

These files shadow the builtin `pi-subagents` role definitions at user scope.
They were copied from `pi-subagents` 0.34.0 at upstream commit
`96d0bd8e3580c76aef3509fa8f47dd7fedd1d9dd`.

## Ownership split

- `agents/*.md` owns each role's frontmatter and system prompt.
- `~/.pi/agent/settings.json` owns local model, thinking, and tool overrides.
- The Markdown intentionally omits `tools` and `thinking`, allowing
  `subagents.agentOverrides` to fill those fields for these custom agents.

The tool overrides preserve each upstream allowlist and only translate tools
that differ locally:

- `web_search` becomes `exa_search`.
- `fetch_content` and `get_search_content` collapse into `webfetch`.
- All other upstream tool names remain unchanged.

The researcher prompt is also adjusted for the local tool schemas: `exa_search`
accepts one query per call, and `webfetch` retrieves selected source pages.

## Installation

From the repository root, run:

```bash
./create-pi-subagent-symlinks.sh
```

This creates one symlink per definition under `~/.pi/agent/agents/`. User agent
definitions take precedence over installed-package and builtin definitions with
the same runtime name. The script refuses to replace existing files or unrelated
symlinks.

Restart Pi or use `/reload`, then verify with:

```text
/subagents-doctor
/subagents-models researcher
```

When updating from upstream, compare all files in `agents/`, preserve the
ownership split above, update the tool-name references in the context-builder
and researcher prompts, and record the new version and commit here.
