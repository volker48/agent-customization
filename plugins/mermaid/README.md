# mermaid

A Claude Code mod that draws ` ```mermaid ` blocks in assistant replies as
images in the terminal, instead of showing their source.

Diagrams are rendered by [merman-cli](https://docs.rs/merman-cli), a native
Mermaid renderer (no headless browser), and drawn with the kitty graphics
protocol, so they show in Ghostty and kitty. Elsewhere the terminal draws the
image's alt text.

## Requirements

- `merman-cli` on `PATH` (`brew install merman-cli`). Tested with 0.9.0.
- A terminal with the kitty graphics protocol (Ghostty, kitty).

## How it works

- Only closed fences are drawn, so a diagram appears once Claude finishes
  writing the block. Prose around it is drawn as markdown.
- PNGs are cached under `~/.cache/claude-mermaid/`, keyed by a hash of the
  diagram source and render flags. Delete the folder to clear it.
- The Mermaid theme follows the Claude Code theme: `default` for light
  themes, `dark` otherwise.
- If `merman-cli` is missing or cannot parse a diagram, the source block stays
  visible and a toast says why.
- Only the terminal is changed. The stored transcript keeps the source, and
  other surfaces draw replies as usual.

## Install

Type this at the prompt of a Claude Code session:

```text
/plugin install mermaid --marketplace volker48/agent-customization
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in
every session). Get later changes with `claude plugin update mermaid` and
`/reload-plugins`.

To run it from a working copy while changing it:

```sh
claude --plugin-dir /path/to/agent-customization/plugins/mermaid
```

## Development

The mod's checks are Claude Code's, not the repository's vitest suite:

```sh
claude plugin validate plugins/mermaid
claude plugin test plugins/mermaid
tsc -p plugins/mermaid   # once Claude Code has loaded the mod and written its types
```
