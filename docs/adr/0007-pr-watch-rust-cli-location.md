# pr-watch is a Rust CLI under crates/pr-watch

**Status:** accepted

## Decision

`pr-watch` is ported from TypeScript to Rust and lives at `crates/pr-watch` in the root Cargo
workspace. The repository commits `Cargo.lock` because this is an application CLI.

The CLI is built with:

```bash
cargo build --release
```

and invoked as `target/release/pr-watch` or through any copied/symlinked binary on `PATH`.

## Consequences

ADR-0005 and ADR-0006 remain authoritative for behavior: subcommands, flags, output shape,
settledness semantics, bot adapters, forge providers, and exit codes are unchanged. This ADR only
supersedes their TypeScript implementation path and tsx execution details.
