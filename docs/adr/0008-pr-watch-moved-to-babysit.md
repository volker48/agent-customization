# pr-watch moved to the standalone babysit project

**Status:** accepted

## Decision

The PR/MR watcher formerly maintained at `crates/pr-watch/` is renamed `babysit`
and moved to the standalone [`babysit`](https://github.com/volker48/babysit)
repository.

`agent-customization` no longer owns the Rust Cargo workspace, `Cargo.lock`, Rust
toolchain pin, Rust CI job, or watcher source/tests. This repository may link to
`babysit` as an external companion CLI, but implementation changes, GitLab CI,
releases, and installation docs belong in the standalone project.

## Consequences

- ADR-0007 is superseded: the CLI no longer lives under `crates/pr-watch` in this
  repository.
- ADR-0005 and ADR-0006 remain useful historical rationale for the watcher shape,
  bot adapters, forge providers, and settledness contract; the `babysit`
  repository is authoritative for current implementation details.
- The root GitLab CI for this repository returns to Node/Pi-extension verification
  only. Rust format, clippy, test, and release-build gates run in `babysit`.
