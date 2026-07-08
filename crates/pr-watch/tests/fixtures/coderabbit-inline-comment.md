_📐 Maintainability & Code Quality_ | _🟠 Major_ | _⚡ Quick win_

**Three copies of the "active statuses" set, scattered across the galaxy they are.**

`ACTIVE_JOB_STATUSES` here duplicates `ACTIVE_STATUSES` in both `cancel.mjs` and `render.mjs` — same three values, three places to keep in sync. Export one canonical set from `jobs.mjs` and import it everywhere, you should. Drift between them, easy to introduce and hard to notice, it would be (e.g. a status added to one set but not the others silently breaks stale-marking, cancellation eligibility, or status labeling).

<details>
<summary>♻️ Suggested consolidation</summary>

```diff
-const ACTIVE_JOB_STATUSES = new Set(["queued", "running", "cancelling"]);
+export const ACTIVE_JOB_STATUSES = new Set(["queued", "running", "cancelling"]);
```
Then in `cancel.mjs` and `render.mjs`:
```diff
-const ACTIVE_STATUSES = new Set(["queued", "running", "cancelling"]);
+import { ACTIVE_JOB_STATUSES as ACTIVE_STATUSES } from "./jobs.mjs";
```
</details>

<!-- suggestion_start -->

<details>
<summary>📝 Committable suggestion</summary>

> ‼️ **IMPORTANT**
> Carefully review the code before committing. Ensure that it accurately replaces the highlighted code, contains no missing lines, and has no issues with indentation. Thoroughly test & benchmark the code to ensure it meets the requirements.

```suggestion
import { isProcessAlive } from "./process-tree.mjs";

export const DEFAULT_DATA_DIR = join(homedir(), ".local", "state", "claude-pi-companion");
export const RECENT_JOBS_LIMIT = 20;

const JOB_LOCK_POLL_MS = 25;
const JOB_LOCK_TIMEOUT_MS = 5_000;
export const ACTIVE_JOB_STATUSES = new Set(["queued", "running", "cancelling"]);
```

</details>

<!-- suggestion_end -->

<details>
<summary>🤖 Prompt for AI Agents</summary>

```
Verify each finding against current code. Fix only still-valid issues, skip the
rest with a brief reason, keep changes minimal, and validate.

In `@plugins/pi/scripts/lib/jobs.mjs` around lines 16 - 23, Consolidate the
duplicated active-status definitions by making jobs.mjs the single source of
truth for the status set. Export the canonical ACTIVE_JOB_STATUSES from
jobs.mjs, then update the logic in cancel.mjs and render.mjs to import and use
that shared constant instead of maintaining local copies. Make sure all
references to active status checks and labeling use the same exported set so any
future status changes stay consistent across cancellation, stale-marking, and
rendering.
```

</details>

<!-- fingerprinting:phantom:poseidon:beignet -->

<!-- cr-indicator-types:refactor_suggestion -->

<!-- cr-comment:v1:b4f4df041e5603800e2010a4 -->

<!-- This is an auto-generated comment by CodeRabbit -->
