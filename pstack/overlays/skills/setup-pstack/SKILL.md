---
name: setup-pstack
description: Configure the Pi models pstack uses per role. Reads Pi settings and pi-subagents runtime mappings, validates model refs, and writes the user override under PI_CODING_AGENT_DIR (default ~/.pi/agent). Use for /setup-pstack, "configure pstack models", or changing pstack model choices.
---

# Set up pstack for Pi

Configure pstack's role-to-model mapping for Pi and `pi-subagents`. The [tracked defaults](../../model-defaults.json) live beside the generated Pi skills. Resolve that link relative to this skill directory. User overrides live at `$PI_CODING_AGENT_DIR/pstack.json` when that environment variable is set, otherwise `~/.pi/agent/pstack.json`; they take precedence.

## Steps

1. Resolve the Pi agent directory from `$PI_CODING_AGENT_DIR`, falling back to `~/.pi/agent`. Read `settings.json`, the linked `../../model-defaults.json`, and an existing `pstack.json` there when present. Resolve the defaults path relative to this skill. Do not expose credentials or unrelated settings.
2. Inspect the live builtin mapping with `subagent({ action: "models" })`. Treat `enabledModels` in Pi settings as the scoped model catalogue when it is non-empty. A model inherited from the parent uses the literal value `inherit-parent`.
3. Build the effective role map. Existing user overrides win, then tracked defaults. Preserve role names exactly because pstack skills refer to them by name.
4. Show the effective map. Mark model refs absent from `enabledModels` as unresolved after removing an optional trailing thinking suffix such as `:high` or `:xhigh`. Ask only whether the user wants changes or whether unresolved refs need replacements. Use ordinary chat when no structured interview tool is available.
5. Validate every concrete model against the scoped catalogue. `inherit-parent` is always valid. For a panel role, validate every entry. Never invent a model ref.
6. Write `pstack.json` in the resolved Pi agent directory as JSON with this shape:

```json
{
  "version": 1,
  "roles": {
    "feature, refactoring": "provider/model:thinking",
    "interrogate reviewers": [
      "provider/model:thinking",
      "other-provider/other-model:thinking"
    ]
  }
}
```

Use an array for panel roles and one string for single-model roles. Supported thinking suffixes are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Overwrite the whole file so reruns are idempotent. Do not edit `settings.json` in the Pi agent directory; it remains authoritative for Pi and builtin subagent defaults.
7. Tell the user what changed. The pstack Pi extension reloads this file on each turn, so no Pi restart is needed. `/pstack-status` shows the effective configuration.
8. If the project lacks a real behavior-verification harness, offer `/create-verification-skill` once. Do not push after a decline.

## Role semantics

- Code roles select the model passed to `worker` or another mutation-capable agent.
- Explorer and investigator roles normally use `scout`, `researcher`, or `delegate`.
- Reviewer, critic, and judge roles normally use fresh-context `reviewer` agents.
- Judgment and prose roles use `oracle`, `reviewer`, or the parent, depending on whether the task is advisory, adversarial, or final synthesis.
- `arena runners`, `architect runners`, `how critics`, and `interrogate reviewers` are panels. One child runs per entry.
- `arena cross-judge pool` is a pool. Pick one model, preferably from a different family than the parent.
- `swarm workers` is the default for every worker unless the task explicitly defines a model race.
