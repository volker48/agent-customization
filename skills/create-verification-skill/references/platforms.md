# Harness compatibility notes

Generated verification skills follow the [Agent Skills](https://agentskills.io) format: a directory with a `SKILL.md` whose YAML frontmatter has `name` and `description`. The harnesses differ only in where they look for project skills and how a user invokes one explicitly.

| Harness     | Project skill directories it scans              | Explicit invocation           | Opt out of implicit (model) invocation          |
| ----------- | ----------------------------------------------- | ----------------------------- | ----------------------------------------------- |
| Claude Code | `.claude/skills/`                               | `/verify-<app>`               | `disable-model-invocation: true` in frontmatter |
| Codex       | `.agents/skills/` (cwd up to repo root)         | `$verify-<app>` or `/skills`  | `policy.allow_implicit_invocation: false` in `agents/openai.yaml` |
| Pi          | `.agents/skills/` (cwd and ancestors), `.pi/skills/` | `/skill:verify-<app>`    | `disable-model-invocation: true` in frontmatter |

## Recommended layout

```
.agents/skills/verify-<app>/          # canonical copy (Codex, Pi)
  SKILL.md
  features/
    README.md
    <feature>.md
  scripts/                            # executable helpers, invoked from the repo root
.claude/skills/verify-<app>           # symlink -> ../../.agents/skills/verify-<app> (Claude Code)
```

Create the symlink from the repo root:

```bash
mkdir -p .claude/skills
ln -s ../../.agents/skills/verify-<app> .claude/skills/verify-<app>
```

## Portability rules

- Unknown frontmatter keys are ignored by all three harnesses, but keep generated skills to `name` and `description` so they stay valid everywhere.
- Helpers run through the shell. Every harness has a shell tool; not every harness has a browser tool, an MCP server, or subagents.
- Subagents are optional. When a harness offers them (Claude Code's Agent tool, Codex subagents, Pi's subagent extension), use them for parallel read-only work; otherwise do the same work sequentially and keep notes compact.
- Paths in skill bodies are relative to the repo root. Skills are loaded from different directories per harness, but commands always run from the project.
