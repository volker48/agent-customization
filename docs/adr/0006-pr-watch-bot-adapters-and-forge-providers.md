# pr-watch uses bot adapters and forge providers

**Status:** accepted

Supersedes no behavior from ADR-0005; it preserves the GitHub + CodeRabbit/Codex settledness,
exit-code, output, and distillation contract while making two extension axes explicit.

## Decision

`pr-watch` now separates PR normalization from bot comment parsing.

- `BotAdapter` describes one review bot: canonical login, display short name, status-check names
  that count as a landed review signal, inline-comment distillation, optional actionable-count
  parsing, and optional review-body findings.
- `ForgeProvider` describes one forge: a `github` or `gitlab` provider that owns CLI I/O and
  normalizes raw forge data into the shared `PrSnapshot` core type.

The CLI remains the orchestration layer: argument parsing, forge selection, wait retries, exit
codes, and rendering. Core settledness and rendering stay forge-neutral.

## GitLab mapping

The GitLab provider uses `glab` and normalizes merge requests into the same `PrSnapshot` fields:
`opened` → `OPEN`, `merged` → `MERGED`, and `closed` → `CLOSED`, so merged/closed MRs settle
unconditionally like terminal GitHub PRs.

GitLab pipeline jobs map to checks. `success` passes, `failed` and `canceled` fail, `skipped`
skips, and non-terminal states remain pending. `manual` is intentionally treated as skipped so a
manual deployment gate cannot make `pr-watch wait` hang forever.

GitLab discussions become findings when the first note is resolvable, authored by a configured bot,
and has position data. GitLab does not expose a direct equivalent of GitHub's outdated review-thread
flag through this path, so GitLab findings are marked `outdated: false`.

GitLab bots do not post commit-anchored PR reviews. The provider synthesizes `BotReview` entries
from each configured bot's latest top-level summary note. It fetches the head commit's
`committed_date`, allowing the existing `submittedAt >= headCommittedAt` landed-review rule to work
unchanged.

## Forge auto-detection

`--forge github|gitlab` selects a provider explicitly. Without the flag, `pr-watch` runs
`git remote get-url origin` and inspects the origin host. If the host contains `gitlab` (including
`gitlab.com` and self-hosted `gitlab.*` hosts), GitLab is selected; otherwise GitHub is selected.
Failure to read the origin remote also defaults to GitHub.
