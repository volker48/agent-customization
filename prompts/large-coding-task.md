---
description: Plan and execute a larger coding task in small validated slices
argument-hint: "<task>"
---
Task: $ARGUMENTS

Work in small RGR/TDD slices. Prefer narrow, reversible changes over broad rewrites.

Before editing:
1. Read the relevant docs, specs, tests, and code paths.
2. Summarize acceptance criteria.
3. List project/framework constraints and anti-patterns to avoid.
4. Propose no more than 5 todos.
5. Identify the exact validation commands to run.
6. Stop and ask if requirements or risk boundaries are ambiguous.

Implementation rules:
- Add or identify the failing behavior/regression test before implementation when practical.
- Implement one slice at a time.
- Inspect existing project patterns before introducing new abstractions.
- Do not invent speculative features or config.
- If the straightforward fix conflicts with project idioms, stop and explain the tradeoff.
- Turn repeated corrections into durable repo/global agent rules when appropriate.

After each slice:
1. Show changed files.
2. Run the relevant tests, typecheck, and linter/formatter.
3. Run `git diff` / `git status` and inspect the result.
4. Summarize what changed, what validation passed/failed, deviations from the plan,
   remaining risks, and the next step.

For work spanning sessions or repos, create a handoff in `/tmp` with branches/MRs,
changed files, validation run, risks, and the next exact task.
