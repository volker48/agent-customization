**Actionable comments posted: 1**

<details>
<summary>🧹 Nitpick comments (2)</summary><blockquote>

<details>
<summary>tests/claude-pi-jobs.test.ts (1)</summary><blockquote>

`42-54`: _📐 Maintainability & Code Quality_ | _🔵 Trivial_ | _💤 Low value_

**Twice, this helper appears.**

`exitedProcessPid` here, word-for-word the same as in `tests/claude-pi-background-cancel.test.ts` it is. A shared test-utils module for spawning a short-lived, already-exited process, worth extracting it would be — small reward, but keeps the two suites from drifting apart on such a fiddly helper.

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@tests/claude-pi-jobs.test.ts` around lines 42 - 54, The exitedProcessPid
helper is duplicated across test suites and should be extracted to a shared test
utility to avoid drift. Move the short-lived process spawning logic from
exitedProcessPid into a common helper module, then update both the
claude-pi-jobs and claude-pi-background-cancel tests to import and use that
shared function instead of maintaining separate copies.
```

</details>

<!-- cr-comment:v1:8207c90a7031265f986fda70 -->

</blockquote></details>
<details>
<summary>plugins/pi/scripts/lib/cancel.mjs (1)</summary><blockquote>

`63-67`: _📐 Maintainability & Code Quality_ | _🔵 Trivial_ | _⚡ Quick win_

**Twice this liveness check written, it is.**

A near-identical `hasDeadWorkerPid` lives also in `plugins/pi/scripts/lib/jobs.mjs` (lines 160-168), save that the `jobs.mjs` version also gates on `ACTIVE_JOB_STATUSES`. Two copies of the same wisdom, dangerous it is — diverge they may, when next this logic changes.

Extract to a shared helper (e.g. in `process-tree.mjs`, alongside `isProcessAlive`), the status gate as an optional parameter or left to the caller, you should.

<details>
<summary>♻️ Suggested consolidation</summary>

```diff
-function hasDeadWorkerPid(job) {
-  const pid = job.workerPid;
-  return Number.isInteger(pid) && pid > 0 && !isProcessAlive(pid);
-}
+import { hasDeadWorkerPid } from "./process-tree.mjs"; // shared with jobs.mjs
```
</details>

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@plugins/pi/scripts/lib/cancel.mjs` around lines 63 - 67, The worker PID
liveness check is duplicated in hasDeadWorkerPid, and a near-identical copy
exists in jobs.mjs, so consolidate it into a shared helper next to
isProcessAlive in process-tree.mjs. Move the common pid validation and liveness
logic into that helper, and make the ACTIVE_JOB_STATUSES gating optional or keep
it in the caller so cancel.mjs and jobs.mjs both use the same source of truth.
```

</details>

<!-- cr-comment:v1:8abc434a4f8b0998911d486a -->

</blockquote></details>

</blockquote></details>

<details>
<summary>🤖 Prompt for all review comments with AI agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

Inline comments:
In `@plugins/pi/scripts/lib/jobs.mjs`:
- Around line 16-23: Consolidate the duplicated active-status definitions by
making jobs.mjs the single source of truth for the status set. Export the
canonical ACTIVE_JOB_STATUSES from jobs.mjs, then update the logic in cancel.mjs
and render.mjs to import and use that shared constant instead of maintaining
local copies. Make sure all references to active status checks and labeling use
the same exported set so any future status changes stay consistent across
cancellation, stale-marking, and rendering.

---

Nitpick comments:
In `@plugins/pi/scripts/lib/cancel.mjs`:
- Around line 63-67: The worker PID liveness check is duplicated in
hasDeadWorkerPid, and a near-identical copy exists in jobs.mjs, so consolidate
it into a shared helper next to isProcessAlive in process-tree.mjs. Move the
common pid validation and liveness logic into that helper, and make the
ACTIVE_JOB_STATUSES gating optional or keep it in the caller so cancel.mjs and
jobs.mjs both use the same source of truth.

In `@tests/claude-pi-jobs.test.ts`:
- Around line 42-54: The exitedProcessPid helper is duplicated across test
suites and should be extracted to a shared test utility to avoid drift. Move the
short-lived process spawning logic from exitedProcessPid into a common helper
module, then update both the claude-pi-jobs and claude-pi-background-cancel
tests to import and use that shared function instead of maintaining separate
copies.
```

</details>

<details>
<summary>🪄 Autofix (Beta)</summary>

Fix all unresolved CodeRabbit comments on this PR:

- [ ] <!-- {"checkboxId": "4b0d0e0a-96d7-4f10-b296-3a18ea78f0b9"} --> Push a commit to this branch (recommended)
- [ ] <!-- {"checkboxId": "ff5b1114-7d8c-49e6-8ac1-43f82af23a33"} --> Create a new PR with the fixes

</details>

---

<details>
<summary>ℹ️ Review info</summary>

<details>
<summary>⚙️ Run configuration</summary>

**Configuration used**: Organization UI

**Review profile**: CHILL

**Plan**: Pro Plus

**Run ID**: `42a90fcc-c937-49d6-9b6b-ddf3f4101f78`

</details>

<details>
<summary>📥 Commits</summary>

Reviewing files that changed from the base of the PR and between aedc0e552aa517404e863501fb100471ca11cb2a and cb792080208df24f4e4e3f21cc51ff46b5a407ed.

</details>

<details>
<summary>📒 Files selected for processing (9)</summary>

* `plugins/pi/commands/implement.md`
* `plugins/pi/scripts/lib/cancel.mjs`
* `plugins/pi/scripts/lib/implement.mjs`
* `plugins/pi/scripts/lib/jobs.mjs`
* `plugins/pi/scripts/lib/render.mjs`
* `plugins/pi/scripts/lib/review.mjs`
* `tests/claude-pi-background-cancel.test.ts`
* `tests/claude-pi-jobs.test.ts`
* `tests/claude-pi-review.test.ts`

</details>

</details>

<!-- This is an auto-generated comment by CodeRabbit for review status -->
