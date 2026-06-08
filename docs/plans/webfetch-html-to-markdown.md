# Plan: HTML→Markdown conversion for `webfetch`

## Goal
Cut token usage when a server returns `text/html` despite the markdown-first
`Accept` header. Today such responses are returned as raw HTML (huge token
cost). Add Readability + Turndown so HTML is converted to clean markdown before
it reaches the model, with safe fallbacks that can never make a fetch fail.

## Decisions (locked)
| Decision | Choice |
|---|---|
| DOM library for Readability | `linkedom` (lightweight vs jsdom; compatible in practice) |
| Default behavior | Conversion ON for `text/html`; opt out with `raw: true` |
| Config surface | Single `raw: boolean` param (auto fallback chain handled internally) |
| GFM support | Include `turndown-plugin-gfm` (tables/strikethrough/task lists) |
| Metadata header | Prepend `# Title` + source line from Readability metadata |
| Max HTML to convert | 5 MB; above this skip conversion, fall back to raw truncation |
| Dependency placement | `dependencies` (required at runtime; `pi install` omits devDeps) |

## Dependencies to add
Pin exact versions, verify current stable at implementation time, respect
`.npmrc` (`minimum-release-age=1440`, `ignore-scripts=true`).

- `@mozilla/readability` (0.6.0 at planning time)
- `turndown` (7.2.4 — bundles `@mixmark-io/domino`, no jsdom needed)
- `turndown-plugin-gfm` (verify latest)
- `linkedom` (0.18.12 at planning time)

Add to `dependencies`. Note deployment caveat: a **symlinked** extension resolves
deps via realpath; a **copied** `.ts` will not — document this in README, or
recommend distribution as a pi package.

## Pipeline change
Conversion runs only for: `text/html` + 2xx + `raw !== true` + non-probe mode +
body under the byte cap. Smart-strategy markdown alternates are still preferred
and tried first; conversion is the fallback when HTML is what we're left with.

```
fetch (existing) → text/html & 2xx & convert-enabled & under cap?
  ├─ buffer full HTML in memory (≤ MAX_CONVERT_BYTES = 5 MB)
  ├─ linkedom.parseHTML(html) → Document (seed base URL = finalUrl for abs links)
  ├─ Readability(document).parse() → { title, content(HTML), byline, siteName, length }
  │     ├─ result && length ≥ charThreshold → turndown(content)
  │     └─ null / too short → fallback: turndown(full <body> HTML)
  │           └─ still empty → raw HTML head (current behavior) + note
  ├─ optional: prepend "# {title}" + "Source: {finalUrl}" (+ byline/siteName)
  └─ apply existing truncateHead + maxChars to the markdown
```

Everything else is untouched: JSON, plain text, already-markdown responses,
probe mode, and the smart-alternate path.

## Why buffering is required
Current `streamResponseText` writes the full body to a temp file while keeping
only an incrementally-truncated head in memory. Readability/Turndown need the
**whole DOM**, so for HTML we buffer the complete body (bounded by the 5 MB cap)
before converting, then run the existing truncation on the resulting markdown.
This is the main structural change; the streaming path stays for non-HTML.

## New code (helpers)
- `convertHtmlToMarkdown({ html, baseUrl }): { markdown, title?, byline?, siteName?, usedReadability, fallback }`
- `extractArticle(html, baseUrl)` — linkedom parse + Readability, wrapped in try/catch
- `htmlToMarkdown(html)` — configured Turndown instance + gfm plugin (module-level singleton)
- `buildMarkdownHeader(meta, finalUrl)` — title/source/byline lines
- Gate helper `shouldConvert({ contentType, status, mode, raw, byteLength })`

All conversion wrapped so any failure degrades to current raw behavior.

## Params / details
- Add `raw?: boolean` (default `false`) to `WebFetchParams`, with description
  explaining it returns unconverted HTML.
- Extend `WebFetchDetails` with: `converted: boolean`, `conversionMethod:
  "readability" | "full-page" | "none"`, `originalHtmlBytes?`, and reuse existing
  char counts so the token-savings story is visible in diagnostics.

## Security notes
- linkedom and domino do **not** execute scripts — no JS runs on fetched HTML.
- DOM parse is synchronous and cannot honor the abort signal mid-parse; the 5 MB
  cap bounds CPU/memory on adversarial input.
- Output is markdown fed to an LLM (not rendered HTML), so DOMPurify is not
  required here; note this assumption in code comments.
- Keep existing SSRF guards, credential redaction, header blocking unchanged.

## Testing (mock fetch, real converters — converters are deterministic in-proc)
1. HTML article → markdown; output length << input; `# Title` present;
   `details.conversionMethod === "readability"`.
2. Table-heavy HTML → GFM markdown table in output (validates gfm plugin).
3. Thin/non-article HTML → falls back to full-page turndown; `conversionMethod
   === "full-page"`; still markdown.
4. JS-shell HTML → conversion yields little; smart guidance still emitted; no crash.
5. `raw: true` → bypasses conversion, returns HTML as today.
6. Non-HTML (json / text/markdown / text/plain) → untouched.
7. Probe mode → no conversion (partial body).
8. Oversized HTML (> cap) → conversion skipped, raw truncation path; `converted false`.
9. maxChars/line/byte truncation applied to converted markdown (full output saved).
10. Conversion throw → caught, degrades to raw, fetch still succeeds.

Per AGENTS.md: write each test against the specific regression, verify it fails
before the implementation lands.

## Risks / open items
- Readability+linkedom edge cases — mitigated by try/catch + full-page fallback.
- Tracking-URL bloat from `<a href>` — consider a turndown rule to drop or
  shorten links if token measurements show it matters (defer until measured).
- Image handling — default turndown keeps `![alt](src)`; consider stripping
  `data:` URIs (can be huge). Add a rule only if observed.
- Confirm exact current versions + 24h release-age compliance before install.
