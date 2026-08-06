# pstack Pi adapter contract

This contract overrides Cursor-specific runtime instructions in the upstream pstack text. Preserve pstack's engineering method and verification requirements, but express execution through Pi and `pi-subagents`.

## Orchestration

- Cursor `Task` or `Agent` calls map to the `subagent` tool. Launch independent work with `async: true`; use one `tasks` call for parallel fan-out and set `context: "fresh"` for independent explorers, reviewers, judges, and critics.
- `subagent_type: generalPurpose` maps by purpose. Use `scout` or `context-builder` for local exploration, `researcher` for external evidence, `reviewer` for read-only review or judging, `worker` as the sole normal writer, `oracle` for inherited-context judgment, and `delegate` only when no focused role fits.
- `subagent_type: poteto-agent` maps to `pstack.poteto`. That agent is an explicitly configured fan-out child. Other children must not launch subagents.
- Cursor `run_in_background: true` maps to `async: true`. Cursor `readonly: true` maps to a fresh read-only role plus an explicit no-edits task constraint; role choice is not a security boundary. Omit acceptance contracts for review-only runs.
- Cursor cloud/local environment fields and `cloud_base_branch` have no Pi equivalent. Use the current local checkout. For parallel writers, require a clean tree and `worktree: true`; otherwise keep one writer in the active worktree.
- Use `subagent_wait` only when the workflow must return complete results in the current turn. Never poll or sleep to wait.
- The parent owns orchestration, synthesis, user decisions, and final verification. Child summaries are evidence, not completion proof.

## Models

Read the effective role map supplied by the `pstack` Pi extension. It merges `pstack.json` from `$PI_CODING_AGENT_DIR` (default `~/.pi/agent`) over `pstack/pi/model-defaults.json`. Ignore Cursor model slugs and `~/.cursor/rules/pstack-models.mdc`. A configured `inherit-parent` value means omit the per-run model override. A `provider/model:thinking` value is a pi-subagents per-run model ref.

## Tools and paths

- Cursor `Read`, `Grep`, `Glob`, and shell operations map to Pi `read`, `grep`, `find`, and `bash`.
- Cursor `TaskCreate`, `TaskUpdate`, `TaskList`, and `TaskGet` map to `pstack_tasks`. Start a multi-step pstack workflow by resetting the list, then add or update entries as phases change.
- Cursor `AskQuestion` maps to an ordinary user question. Ask only for genuine product, preference, irreversible-action, or unresolved scope decisions. Experiment or inspect first when evidence can decide.
- MCP means the tools and extensions actually registered in the current Pi session. Do not inspect a Cursor `mcps/` directory or assume a source exists. `git` and `gh` cover source control; `exa_search` and `webfetch` cover public web evidence. Report every unavailable evidence category as a gap.
- The active Pi transcript is `PI_SESSION_FILE`. Prior same-workspace sessions live under its parent workspace session directory. Never glob across unrelated workspace session directories.
- Project skills belong under `skills/<name>/SKILL.md` in this package or `.pi/skills/<name>/SKILL.md` for project-only work. User skills belong under `~/.pi/agent/skills/<name>/SKILL.md`.

## Cursor-only helpers

- Cursor `create-skill` maps to this package's `/learn` workflow or direct Agent Skills authoring under the paths above.
- Cursor `deslop` maps to pstack's `unslop` skill unless another installed cleanup skill is explicitly available.
- Cursor `/loop` maps to a parent-controlled, bounded iteration loop with an explicit stop predicate and verification after each accepted iteration.
- `babysit`, `control-cli`, and `control-ui` are optional external capabilities, not Pi built-ins. Use them only when actually installed. Otherwise use `gh`, the project's real verification harness, and the available Pi tools, and state the gap.
- Visual work follows the active Pi visual-explainer policy. Do not assume Cursor image generation is available.

## Replies

Keep upstream pstack's output contracts and prose discipline. When upstream asks for Cursor-only status, translate it to Pi run ids, artifact paths, session paths, worktrees, commands, and validation evidence.
