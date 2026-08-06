# pstack for Pi

This directory adapts Cursor's [pstack](https://github.com/cursor/plugins/tree/main/pstack) to this repository's Pi package and `pi-subagents` setup.

## Layout

- `upstream/` is an exact, generated snapshot of the upstream `pstack/` subtree. Do not edit it.
- `overlays/` is the hand-maintained Pi adaptation source.
- `pi/` is the generated package surface loaded by Pi. Do not edit it.
- `upstream.json` pins the upstream commit and git tree.
- `../scripts/sync-pstack.mjs` fetches upstream and regenerates both generated trees.

The generated skill bodies retain upstream text so upstream changes remain visible. Every skill links to `pi/PI_ADAPTER.md`, whose contract translates Cursor `Task`, model, transcript, MCP, and helper assumptions to Pi. `setup-pstack` and `pstack.poteto` are full Pi overlays because their Cursor definitions are runtime-specific.

## Use

Reload Pi after the first install or after changing the package manifest:

```text
/reload
```

The extension registers Cursor-style aliases for every pstack skill:

```text
/poteto-mode <task>
/how <question>
/interrogate <review target>
/setup-pstack
```

The ordinary Pi forms also work:

```text
/skill:poteto-mode <task>
/skill:how <question>
```

`/poteto-mode` is sticky for the current Pi session. Disable it with `/pstack-off`. Inspect the current mode, upstream commit, and model configuration with `/pstack-status`.

The extension also registers `pstack_tasks`, a session-branch-aware checklist tool used in place of Cursor's TaskCreate/TaskUpdate tools.

## Subagent

The package publishes `pstack.poteto` through `pi.subagents.agents`. It is the Pi equivalent of upstream `poteto-agent` and is intentionally allowed to perform bounded child fan-out:

```text
Use pstack.poteto to carry this task through poteto-mode end to end.
```

The role defaults to forked context, reads `poteto-mode`, and maps work to the installed `scout`, `context-builder`, `researcher`, `reviewer`, `worker`, `oracle`, and `delegate` roles. Parallel writers require isolated worktrees. Normal active-worktree changes stay single-writer.

After `/reload`, verify discovery with:

```text
/subagents-doctor
/subagents-models
```

or ask Pi to list subagents and confirm `pstack.poteto` appears.

## Models

Tracked defaults are in `overlays/model-defaults.json` and were selected from the models enabled in `~/.pi/agent/settings.json`:

- Luna handles fast exploration and ordinary implementation.
- Sol handles precise implementation, synthesis, and judgment.
- Sol, Opus, MiniMax, and Kimi provide diverse review/design panels.

Run `/setup-pstack` to validate or customize the mapping. It writes only `pstack.json` under `$PI_CODING_AGENT_DIR` (default `~/.pi/agent`); it does not modify Pi's main settings. The extension merges that file over `pi/model-defaults.json` on every turn, so model-invoked skills have the effective role map and changes do not require a restart.

## Pull upstream changes

From the repository root:

```bash
pnpm pstack:sync
pnpm pstack:check --source pstack/upstream
pnpm exec vitest run tests/pstack.test.ts
pnpm typecheck
```

`pstack:sync` sparse-fetches `cursor/plugins` at `main`, replaces the exact snapshot, applies the Pi overlays in a temporary directory, and only then replaces `pstack/pi/`. Use a pinned ref when needed:

```bash
pnpm pstack:sync --ref <tag-or-commit>
```

Review updates in this order:

1. `pstack/upstream.json` and the `pstack/upstream/` diff for upstream intent.
2. `pstack/pi/` for generated effects and any new Cursor-only assumptions.
3. `pstack/overlays/PI_ADAPTER.md` for mapping gaps exposed by new skills.
4. The setup and agent overlays if upstream changed either corresponding source.

Never fix generated files directly. Change an overlay or the generator and rerun sync. The generator fails if upstream changes the `poteto-mode` name normalization it currently owns. It also stops when an upstream path replaced by a full overlay changes, when upstream adds an agent without a namespaced Pi overlay, or when an upstream path would be ignored by this repository's Git rules. Reconcile full-overlay changes, then update `overlays/reconciled-upstream.json` with the reviewed source hash before rerunning. Ignored upstream paths require an explicit repository-storage decision rather than a sync that cannot be reproduced from a fresh clone.

## Known capability boundaries

Pi does not automatically provide Cursor cloud workers, `cloud_base_branch`, Cursor's transcript layout, `AskQuestion`, `/loop`, `create-skill`, `babysit`, `control-cli`, or `control-ui`. The adapter maps them to Pi subagents, `PI_SESSION_FILE`, ordinary user questions, parent-controlled bounded loops, `/learn`, `gh`, and real project verification tools when available. Missing optional evidence or control integrations must be reported as gaps rather than invented.

Upstream pstack is MIT licensed. See `upstream/LICENSE`.
