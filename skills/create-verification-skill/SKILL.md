---
name: create-verification-skill
description: "Generate a project-local verification skill that drives your app the way a user does — any language, framework, or platform — and works from Claude Code, Codex, and Pi alike. Use when invoked as create-verification-skill, for \"make a control/verify skill for this repo\", or when a project has no scripted way to prove UI/CLI/service behavior."
disable-model-invocation: true
license: MIT (see LICENSE.upstream)
metadata:
  adapted-from: "https://github.com/cursor/plugins/blob/4bf3e083c6dec126e254f96181b84a105b6e3e70/pstack/skills/create-verification-skill/SKILL.md"
  upstream-author: "Lauren Tan (pstack)"
---

# Create a verification skill

Every serious project needs a scripted way to drive the real app and prove behavior: launch it, exercise a feature the way a user would, and capture evidence. This skill generates that as a project-local skill (`verify-<app>`) tailored to the repo. You write the generator's output for the next agent, not for a human: it will be read cold, mid-task, by an agent that has never seen the app — and that agent may be Claude Code, Codex, Pi, or another Agent Skills–compatible harness. See [`references/platforms.md`](references/platforms.md) for where each harness discovers skills and how each invokes them.

## 1. Interview the repo, not the user

Answer these from the codebase and only ask the user what you cannot observe:

- **Surface:** what does a user actually touch? A web UI, a CLI/TUI, a desktop app, an API, a mobile app, a library? A repo can have several; pick the primary one and note the rest.
- **Run:** how does the app start locally? Prefer the repo's own documented dev command (package scripts, Makefile, README quickstart). Note ports, env vars, seed data, auth.
- **Drive:** how can an agent interact with it programmatically? Existing harnesses first — Playwright/Cypress specs, expect scripts, PTY helpers, curl-able endpoints, a debug port. Only then pick a generic recipe: a Playwright/CDP script for web and Electron, a tmux/PTY harness for CLI/TUI, plain HTTP for services.
- **Observe:** what evidence can be captured? Screenshots, terminal transcripts, response bodies, logs, exit codes, DB state.
- **Isolate:** can two instances run side by side (ports, data dirs, profiles)? If not, say so in the generated skill: refusing to double-drive a shared instance beats corrupting the user's session.
- **Home:** where do this repo's project skills already live (`.agents/skills/`, `.claude/skills/`, `.pi/skills/`, `.codex/skills/`, `.cursor/skills/`)? Follow an existing convention; otherwise use the portable layout in step 2.

If the checkout doesn't build or start as-is, fix that first (or report it precisely) before generating; a skill written against a broken base teaches wrong steps. When an irrelevant missing asset blocks startup (a static dir the API never serves, a sample config), the generated skill may create it, clearly marked as verification scaffolding, and remove it in cleanup.

## 2. Generate the skill

**Location.** Unless the repo already has a skills convention, write the canonical copy to `.agents/skills/verify-<app>/` (discovered by Codex and Pi) and add a relative symlink `.claude/skills/verify-<app> -> ../../.agents/skills/verify-<app>` so Claude Code finds the same files. One source of truth; never maintain divergent copies. If symlinks are unsuitable (e.g. Windows checkouts without symlink support), say so and pick the directory the user's primary harness reads.

**Portability.** The generated skill must work from any harness with a shell:

- Drive the app through repo-owned, executable helper scripts (shell, Node, Python — whatever the repo already uses), not through harness-specific tools such as a particular browser MCP server, Claude-only slash commands, or a Pi extension. A harness tool may be mentioned as an optional shortcut, never as the only path.
- The generated skill's frontmatter uses only the portable Agent Skills fields: `name: verify-<app>` and a `description` that names the app, the surface, and when to reach for it. Without frontmatter the skill never registers. Leave model invocation enabled so agents can reach for it mid-task.
- Refer to other skills by name ("the `maintain-verification-skill` skill"), not by one harness's invocation syntax.

Write `verify-<app>/SKILL.md` with these sections, each grounded in what the interview actually found (no placeholders left):

- **Launch:** the exact command that starts the app for verification, and how to tell it's ready (a log line, a port answering, a prompt). Include teardown. For a short-lived CLI or TUI there is no server to keep alive: launch means build the binary (or install deps) once, then start each drive in its own isolated PTY or tmux session.
- **Doctor:** one read-only check that answers "is this instance worth driving?" — process up, right version/build, port owned by us, auth valid. An agent runs this first whenever anything looks off.
- **Drive:** the harness recipe with real selectors/commands from this repo, not examples. Prefer stable handles (ARIA labels, data attributes, prompt strings, route paths) over coordinates and tab order.
- **Evidence:** what to capture for a proof and where it goes. State the proof standards: exercise the real user path, not internal setters or test-only endpoints; capture the action and the resulting state, not just the final screen; verify side effects (files written, rows inserted, messages sent) alongside what's visible; mocks only where a production boundary already isolates the external system. When the safe path is a dry-run or test mode, verify what it actually skips by observing (files, network, git refs) rather than trusting its name: some dry-runs still touch the network or open a browser.
- **Cleanup:** how to tear down instances the run created. Never kill by process name; kill what you started (record PIDs, tmux session names, container IDs). Cleanup removes instances and scratch state, never the evidence: proof artifacts survive the teardown, in a location the skill names.
- **Helpers:** any script the skill ships is executable and its invocation is shown in the skill body, using paths relative to the repo root so every harness resolves them the same way. A helper the reader has to reverse-engineer is not a helper.

## 3. Seed the feature map

Create `verify-<app>/features/README.md` plus one file per user-facing feature you can identify (aim for the top 3-5 to start, from routes, commands, menus, or docs). Follow the shape in [`references/feature-map-example/`](references/feature-map-example/), with a README index and one file per feature. Each file answers, from the user's point of view: what the feature is, how to reach it, how to drive it with the harness, and what observable end state proves it works. The four H2s are `Sub-features`, `How to get to it (user POV)`, `Driving it with <harness>`, and `Gotchas`. The map is the repo's maintained verification source; a proof that drives one convenient entry point is incomplete when the map lists others.

## 4. Prove the generated skill before handing it over

Run its own instructions end to end once: launch, doctor, drive ONE mapped feature (one is enough; the map exists so later runs can cover the rest), capture evidence, clean up. After cleanup, confirm the evidence still exists at the named location — a cleanup that eats the proof fails this step. Fix what fails, and run the generated cleanup after every failed iteration too, so broken attempts don't strand processes and ports. Also confirm discovery: the skill directory (and the `.claude/skills/` symlink, if created) resolves to a `SKILL.md` with valid frontmatter. A generated skill that was never executed is a draft, not a deliverable.

## 5. Offer the maintenance loop

Point the user at the `maintain-verification-skill` skill for keeping the map honest as the app changes (`/maintain-verification-skill` in Claude Code, `/skill:maintain-verification-skill` in Pi, `$maintain-verification-skill` in Codex). Suggest a cadence only if they ask.
