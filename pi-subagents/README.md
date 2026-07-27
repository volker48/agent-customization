# Pi subagent customizations

These package-owned definitions shadow only the builtin `pi-subagents` roles whose prompts or launch defaults are intentionally customized here. They were based on `pi-subagents` 0.34.0 at upstream commit `96d0bd8e3580c76aef3509fa8f47dd7fedd1d9dd`.

## Ownership split

- `agents/context-builder.md` adapts external-research guidance to the local `exa_search` tool.
- `agents/researcher.md` adapts search and fetch guidance to the local `exa_search` and `webfetch` schemas.
- `agents/reviewer.md` keeps the repository's intentional non-mutating `bash` guidance.
- `agents/oracle.md` gives high-effort forked Oracle reviews a 15-minute default runtime.
- Bundled definitions remain authoritative for roles without prompt or launch-default customizations.
- `~/.pi/agent/settings.json` owns local model, thinking, and tool overrides for every role.

The Markdown intentionally omits `tools` and `thinking`. `subagents.agentOverrides` fills those unset fields while explicit prompt frontmatter remains package-owned.

The tool overrides preserve each upstream allowlist and translate tools that differ locally:

- `web_search` becomes `exa_search`.
- `fetch_content` and `get_search_content` collapse into `webfetch`.
- All other upstream tool names remain unchanged.

## Discovery

The repository's `package.json` publishes this directory through `pi.subagents.agents`. Because `agent-customization` is already installed as a Pi package, no separate installer or user-scope symlinks are required. Package definitions override builtins with the same runtime name; user and project definitions can still override this package.

Restart Pi or use `/reload`, then verify with:

```text
/subagents-doctor
/subagents-models researcher
```

`/subagents-doctor` reports raw definitions by source, so its totals can include both builtin and package definitions. Runtime execution uses only the highest-precedence definition for each name. `subagent({ action: "list" })` hides shadowed definitions in versions containing upstream fix `4f9d6ae`.

## Updating from upstream

Compare the four files in `agents/` with their upstream counterparts. Keep only intentional prompt or launch-default differences, preserve the ownership split above, update local web-tool references when schemas change, and record the new upstream version and commit here.
