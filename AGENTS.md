## Agent skills

### Issue tracker

Issues are tracked as GitHub issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical label vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Fusion bundle

To ask the Fusion panel about real code, curate files and bundle them for the panel. Shipped as the `fusion` skill (`skills/fusion/SKILL.md`), so the workflow travels with the extension install.
