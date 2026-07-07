# Fusion workflow

## Purpose

Fusion is a Pi slash command that asks multiple inner models for independent answers, has a judge model analyze those answers, and then asks the current Pi model to synthesize the final user-facing answer. `CONTEXT.md` describes this as a panel–judge–synthesis workflow modeled on OpenRouter Fusion.

The implementation lives under `pi-extensions/fusion/`.

## User entrypoint

`pi-extensions/fusion/index.ts` registers `/fusion`:

```text
/fusion <prompt>
/fusion --file <path> [prompt]
```

If `--file` is used, `readBundleFile` loads the bundle and appends/prepends any inline prompt. The `skills/fusion/SKILL.md` workflow exists because panel and judge models do not have filesystem access; an agent curates relevant files into a bundle, then asks the user to run `/fusion --file <bundle>`.

The command displays progress with a cancellable `BorderedLoader`, supports cancellation through `AbortController`, optionally writes a debug log, and finally injects a `fusion-panel` message with `triggerTurn: true`.

## Configuration

`pi-extensions/fusion/config.ts` loads JSON from:

- `PI_FUSION_CONFIG`, if set, otherwise
- `~/.pi/agent/fusion.json`.

Important config fields validated there:

- `judge`: required `provider/model` model ref.
- `models`: required panel model refs, capped at 8.
- `maxToolCalls`: default 8, max 64.
- `maxBinaryQuestions`: default 15, max 64.
- `maxCompletionTokens` and `reasoning.effort`.
- `webSearch` policy: result counts, text size, excluded domains.
- `webfetch` policy: strategy, max chars, blocked domains.
- `debugLogPath`.

Model refs are parsed on the first slash (`pi-extensions/fusion/model-ref.ts`) so OpenRouter-style model ids with additional slashes remain valid.

## Execution pipeline

`runFusion` in `pi-extensions/fusion/orchestrator.ts` is the core pipeline:

1. **Resolve models.** The judge and every panel model are resolved through Pi's model registry. Fusion does not hard-code provider auth.
2. **Create restricted inner tools.** `createFusionTools(config)` returns only `web_search` and `webfetch` for panel/judge calls.
3. **Run meta prompt and panel in parallel.** The judge produces binary dimensions/questions while all panel models answer independently.
4. **Accept degraded panel results.** The run proceeds if at least one panel model succeeds. If all fail, Fusion returns an error.
5. **Run judge.** The judge analyzes successful and failed panel responses with structured dimensions. It produces analysis and scores, not the final answer.
6. **Compute confidence.** `computeConfidence` derives confidence from parsed panel scores.
7. **Return result.** Status is `ok`, `degraded`, or `error` depending on panel/judge outcomes.

## Final synthesis belongs to the calling model

ADR-0002 is load-bearing: the judge does not write the final answer. `runFusion` stops after judge analysis. `index.ts` turns the result into a custom `fusion-panel` message using `toFusionPanelMessage(result)` and calls:

```ts
pi.sendMessage(toFusionPanelMessage(result), { triggerTurn: true });
```

Pi renders the custom message as a compact expandable card, but its content enters LLM context as a user-role synthesis prompt. The active Pi model — whatever `/model` selected — writes the final answer as a normal assistant message. This keeps `/copy` working and lets the final synthesis use the calling model's session/repository/tool context.

## Error and cancellation behavior

- All panel failures: notify error and do not trigger synthesis.
- Judge failure after at least one panel success: notify the judge failure but recover by triggering synthesis from panel responses.
- User cancellation: abort signal stops the run and the UI reports `Fusion cancelled`.
- Debug logging: when `debugLogPath` is configured, command start, progress, result, failure, cancellation, and synthesis-trigger events are logged via `debug-log.ts`.

## Change guidance

- Preserve the judge/calling-model split from ADR-0002.
- Keep config validation strict; unknown keys are rejected in `config.ts`.
- Add or update tests in `tests/fusion*.test.ts` for parser, config, rendering, orchestration, progress, and error behavior.
- Use the bundle skill when asking Fusion about real code; do not assume inner models can read files.
