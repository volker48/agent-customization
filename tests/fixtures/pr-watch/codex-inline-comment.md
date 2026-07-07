**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Do not report cancelling review races as completed**

When `/pi:cancel` or an orchestrator marks a review job `cancelling` after `agent_end` but before `get_last_assistant_text` returns, this guard skips the completed update, yet `executeReview` still has no error and returns `ok: true`; `renderReviewReport` then tells the caller the review completed even though the ledger is still `cancelling` and has no result. Please propagate the cancellation or derive the review outcome from the locked job status after this update.

Useful? React with 👍 / 👎.
