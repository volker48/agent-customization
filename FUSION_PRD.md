# Pi Fusion Extension PRD

## Problem Statement

The user wants a Pi coding agent extension that can deliberately invoke a multi-model fusion workflow from a slash command. Today, Pi can switch between models and providers, and this repository already includes custom web access tools, but there is no single command that sends the same research or architecture prompt to multiple configured models, lets them work in parallel with only safe web tools, and then asks a configured judge model to synthesize the best answer.

The user specifically wants this to model OpenRouter Fusion while remaining provider-agnostic inside Pi: the panel should be able to include models from different Pi-supported providers, including subscription-backed providers and API-key-backed providers, and the judge should be independently configurable. The result should appear in the session like a normal answer, not as an extra prompt that asks the currently selected Pi model to restate the result.

## Solution

Build a new Pi extension that registers a `/fusion` command. The command takes only the command arguments as the fusion prompt. It does not include prior session history or loaded project context in the panel or judge requests.

When invoked, the extension loads a global Fusion configuration, resolves the judge and panel model references through Pi's model registry, validates credentials, and runs the panel models in parallel. Each panel model receives the prompt and only the extension-provided web search and web fetch tools. After at least one panel model succeeds, the configured judge model receives the original prompt, the panel responses, and the same restricted tool set. The judge directly produces the final fused answer.

The extension displays an indeterminate progress UI while the panel and judge are working. The final result is persisted as an extension custom message rendered to look like a normal assistant answer. This uses the supported Pi extension message API rather than private session mutation. The custom message stores display-friendly final-answer content plus structured details for expanded rendering and debugging.

## User Stories

1. As a Pi user, I want to run `/fusion <prompt>`, so that I can explicitly request multi-model deliberation only when I decide it is worth the cost.
2. As a Pi user, I want `/fusion` to use only the text after the command, so that old conversation context does not accidentally leak into fusion requests.
3. As a Pi user, I want to configure the panel models globally, so that I can reuse my preferred fusion panel across all projects.
4. As a Pi user, I want to configure the judge model separately from the panel models, so that I can choose a strong synthesizer without making it part of the panel.
5. As a Pi user, I want panel models to come from different Pi providers, so that I can combine OpenAI, Anthropic, OpenRouter, and other supported providers.
6. As a Pi user, I want the extension to use Pi's model registry, so that existing model IDs, provider configuration, OAuth credentials, and API keys work consistently.
7. As a Pi user, I want subscription-backed models to work when Pi supports them, so that I can fuse models from my existing paid subscriptions.
8. As a Pi user, I want API-key-backed models to work, so that I can include providers such as OpenRouter, DeepSeek, or other custom providers.
9. As a Pi user, I want clear validation errors for missing models, so that I can fix incorrect provider/model references quickly.
10. As a Pi user, I want clear validation errors for missing credentials, so that I know which provider login or API key is missing.
11. As a Pi user, I want panel models to run in parallel, so that fusion latency is bounded by the slowest model rather than the sum of all model latencies.
12. As a Pi user, I want an indeterminate progress indicator while fusion runs, so that I can tell Pi is working even though the normal agent is idle.
13. As a Pi user, I want the progress UI to be cancellable when possible, so that I can stop an expensive fusion run that is taking too long.
14. As a Pi user, I want cancellation to propagate to in-flight model calls and tool calls, so that aborting avoids unnecessary cost and waiting.
15. As a Pi user, I want each panel model to have only web search and web fetch tools, so that inner models cannot read, edit, or execute local project files.
16. As a Pi user, I want the judge model to have only web search and web fetch tools, so that verification can use the web without local codebase access.
17. As a Pi user, I want the inner tools to reuse this repository's custom web access behavior, so that fusion has the same web semantics as the rest of my custom Pi setup.
18. As a Pi user, I want tool-call budgets for panel and judge runs, so that one model cannot loop indefinitely through web searches or fetches.
19. As a Pi user, I want token settings to be configurable, so that I can tune cost and response length.
20. As a Pi user, I want partial panel failure handling, so that a single unavailable provider does not waste successful responses from other models.
21. As a Pi user, I want an all-panel-failed error, so that I do not receive a judge answer based on no useful evidence.
22. As a Pi user, I want judge failure to be reported clearly, so that I can distinguish panel failures from synthesis failures.
23. As a Pi user, I want the judge to compare responses rather than majority-vote, so that unique but correct insights are not discarded.
24. As a Pi user, I want the judge to surface consensus, contradictions, partial coverage, unique insights, and blind spots, so that the synthesis is transparent.
25. As a Pi user, I want the final answer to include caveats when evidence is insufficient, so that the fused response does not hide uncertainty.
26. As a Pi user, I want the judge to prefer primary sources when verifying claims, so that the final answer is more trustworthy.
27. As a Pi user, I want the judge to penalize unsupported confident claims, so that the final answer is not just the most fluent panel response.
28. As a Pi user, I want the final fused result to appear in the Pi session like a normal answer, so that the conversation remains readable.
29. As a Pi user, I want fusion metadata to be available when expanded, so that I can inspect which models participated and what the judge found.
30. As a Pi user, I want raw panel responses stored in result details, so that I can debug or audit surprising fused answers.
31. As a Pi user, I want future Pi turns to have access to the fusion result, so that I can ask follow-up questions based on the fused answer.
32. As a Pi user, I want future context to identify the content as a fusion-generated result, so that downstream models do not misinterpret it as a user-authored claim.
33. As a Pi user, I want `/fusion` to avoid asking the currently selected Pi model to restate the answer, so that the judge remains the direct author of the final response.
34. As a Pi user, I want the default command behavior to be simple, so that `/fusion` does not require inline model configuration on every use.
35. As a Pi user, I want configuration errors to happen before expensive model calls, so that bad setup fails fast.
36. As a Pi user, I want the implementation to be modular, so that later changes to config, model execution, tools, or rendering do not require rewriting the command.
37. As a Pi user, I want the extension to preserve existing standalone web tools, so that adding fusion does not break current `exa_search` or `webfetch` behavior.
38. As a Pi user, I want tests around the command and orchestrator behavior, so that future refactors do not accidentally include session context, enable extra tools, or change error handling.
39. As a Pi user, I want the feature to be provider-agnostic, so that adding a new Pi-supported provider later does not require fusion-specific provider code.
40. As a Pi user, I want fusion to be bounded to a single level, so that panel or judge calls cannot recursively invoke fusion.

## Implementation Decisions

- The extension will register a `/fusion` command as the only user-facing entry point for the first version.
- The command argument string is the entire fusion prompt. The extension will not include the current conversation transcript, loaded context files, skills, prompt templates, or the active editor content.
- Fusion configuration will be global only. Project-local Fusion configuration is out of scope for the first version.
- The global configuration will contain the judge model reference, panel model references, tool-call budget, optional max completion tokens, optional reasoning settings, and optional web tool policies.
- Model references will use Pi's provider/model form. The parser must split on the first slash only so that OpenRouter-style model IDs containing additional slashes can be represented.
- Model references will resolve through Pi's model registry, not through provider-specific code paths.
- Credentials will resolve through Pi's model registry credential APIs, so existing Pi auth behavior remains the source of truth.
- The panel runner will call models directly through Pi's AI completion API rather than spawning nested Pi agent sessions. This keeps the inner tool set explicit and prevents accidental access to coding tools.
- A small bounded tool loop will support model tool calls for the inner panel and judge requests. The loop will execute only the allowlisted web search and web fetch tools.
- The fusion-internal web search tool will be exposed to inner models as `web_search`. It may reuse the existing Exa-backed search implementation, but the model-facing name should match the user's expectation and the OpenRouter Fusion concept.
- The fusion-internal web fetch tool will be exposed to inner models as `webfetch` or a clearly documented equivalent. It should reuse the existing custom web fetch behavior.
- Existing standalone web access tools should be refactored only enough to share implementation with Fusion. Their current user-facing behavior should not change.
- Panel calls will run concurrently. Each panel result will be recorded as either a successful response or a typed failure.
- If all panel models fail, the fusion run fails and no judge request is made.
- If at least one panel model succeeds, the judge receives successful responses and a summary of failed models.
- The judge model directly produces the final fused answer. There is no additional outer writer model.
- The judge prompt will instruct the judge to compare panel responses, identify consensus, contradictions, partial coverage, unique insights, blind spots, source quality issues, risks, confidence, and the final answer.
- The judge prompt will incorporate DRACO-inspired evaluation principles: be strict about factual accuracy, avoid rewarding verbosity, distinguish supported claims from unsupported claims, and prefer primary sources.
- The judge should use web search and web fetch only when useful for verifying disputed, current, or high-impact claims.
- The judge output should be structured so the extension can separate final answer from analysis metadata.
- The displayed result will use Option A: a Pi extension custom message with a custom renderer that makes the final answer look like a normal assistant response.
- The extension will not mutate private session internals to fabricate a standard assistant message.
- The extension will not send a follow-up user message asking the active Pi model to echo the Fusion result.
- The custom message content sent into future LLM context should clearly identify itself as a Fusion-generated result, while the custom renderer can display only the final answer in the normal collapsed view.
- The custom message details should store structured metadata such as judge model, panel models, elapsed time, panel status, analysis, failures, and raw panel responses.
- The default collapsed rendering should prioritize readability and show the judge's final answer.
- Expanded rendering should expose Fusion metadata and judge analysis for auditability.
- The command should show an indeterminate, cancellable progress UI in TUI mode using Pi's existing loader component.
- In non-TUI modes, the command should still run without custom terminal UI and should report errors through available UI notifications or command output behavior.
- The command should validate prompt presence, configuration validity, model existence, credential availability, and panel size before starting model calls.
- Panel size should be bounded. The OpenRouter reference allows one to eight analysis models; this extension should adopt the same default bound unless implementation constraints require a smaller limit.
- Fusion should be single-level only. Inner panel and judge calls should not receive any fusion tool.

## Testing Decisions

- Good tests should exercise externally visible behavior: command registration, config validation, model resolution outcomes, tool allowlisting, orchestration outcomes, result rendering data, and failure messages. Tests should avoid asserting private helper call order unless that order is part of the public behavior.
- The highest-value test seam is the Fusion orchestrator with fake model runners and fake web tools. This seam can verify parallel panel aggregation, partial failure behavior, all-panel-failed behavior, judge invocation inputs, and final result shape without making real provider calls.
- The command handler should be tested with a mocked Pi extension API and command context. These tests should verify that `/fusion` is registered, empty args fail fast, command args are passed as the only prompt, configuration is loaded, and the result sink is called.
- The global config loader should be tested independently with temporary files or injected file readers. Tests should cover missing config, invalid JSON, invalid model refs, missing judge, empty panel, too-large panel, and default values.
- The model reference parser should be tested independently. It must accept provider/model references where the model portion contains additional slashes.
- The model resolver should be tested with a fake model registry. Tests should cover model not found, credential missing, successful API-key auth, and successful header propagation.
- The bounded tool loop should be tested with fake completion responses. Tests should cover no tool calls, one tool call, multiple tool-call rounds, tool-call budget exhaustion, unknown tool rejection, tool execution failure, and cancellation.
- The tool allowlist should be tested by attempting to invoke a non-web tool name from a fake model response and verifying the run does not execute it.
- The web search adapter should be tested at its public behavior seam. Prior art exists in the repository's Exa search extension tests, which mock fetch and assert formatted output and missing-key behavior.
- The web fetch adapter should be tested at its public behavior seam. Prior art exists in the repository's web fetch extension tests, which mock fetch and assert URL handling, content-type handling, truncation metadata, and error results.
- The result sink should be tested with a mocked Pi API to verify that it sends a custom message with the correct custom type, display flag, context content, and details.
- The renderer should be tested at the data-to-display seam where practical. Tests should verify collapsed rendering contains the final answer and expanded rendering includes judge/panel metadata.
- The judge prompt builder should be tested as a pure function. Tests should verify the prompt includes the original user prompt, successful panel responses, failed model summaries, and required JSON output instructions.
- The panel prompt builder should be tested as a pure function. Tests should verify that it contains the command args and does not include session transcript or project context.
- Cancellation behavior should be tested with abort signals passed through fake runner and fake tool calls.
- No test should call real OpenAI, Anthropic, OpenRouter, Exa, or arbitrary web endpoints by default.
- Any future end-to-end test that calls real providers should be opt-in via environment variables, following the repository's existing pattern for opt-in integration tests.

## Out of Scope

- Project-local Fusion configuration.
- Inline `/fusion` arguments for overriding panel or judge models.
- Automatic model selection or automatic router behavior.
- Replacing Pi's active model with a virtual `fusion` model.
- Letting the normal Pi agent decide when to invoke Fusion as a tool.
- Including current session history, project files, AGENTS instructions, skills, or prompt templates in Fusion requests.
- Giving panel or judge models local coding tools such as read, write, edit, bash, grep, find, or ls.
- Recursively allowing Fusion inside panel or judge calls.
- A separate final writer model after the judge.
- Publishing results to an issue tracker.
- Benchmarking Fusion quality against DRACO tasks.
- Implementing a full DRACO evaluator or rubric scorer.
- Adding new third-party dependencies unless the implementation cannot reasonably reuse existing Pi and repository dependencies.

## Further Notes

- The key product decision is that the final answer should look like a normal session answer while using supported extension APIs. The implementation should use a custom message and renderer rather than private session mutation.
- Because Pi converts custom messages into user-role context for future model calls, the message content used for context should clearly label itself as generated Fusion output. The renderer can still present the final answer without a noisy label in the collapsed view.
- DRACO's published judge prompt is for rubric grading, not Fusion synthesis. Its useful contribution here is the evaluation stance: strict factuality, careful handling of negative claims, source quality, and not rewarding verbosity.
- The implementation should keep the core Fusion orchestration independent of Pi TUI rendering so it can be tested without terminal UI.
- The implementation should preserve the existing standalone web search and web fetch tools while extracting reusable core behavior for Fusion's restricted inner tool set.

### Judge Prompt

```text
   You are a fusion judge synthesizing independent model responses.

   You will receive:
   - the user's original task
   - several independent panel responses from different models
   - any web evidence those models cited or that you fetch yourself

   Your job is not to vote and not to average responses. Compare them.

   Evaluate:
   1. Factual accuracy and source support
   2. Breadth and depth of analysis
   3. Contradictions and unresolved uncertainty
   4. Unique insights worth preserving
   5. Blind spots no model covered
   6. Citation/source quality

   Use web_search and webfetch only when needed to verify disputed, current, or high-impact claims.
   Do not introduce unsupported claims.
   Do not hide disagreements. If evidence is insufficient, say so.
   Prefer primary sources over summaries.
   Penalize confident but uncited factual claims.

   Return only valid JSON:

   {
     "analysis": {
       "consensus": [],
       "contradictions": [],
       "partialCoverage": [],
       "uniqueInsights": [],
       "blindSpots": [],
       "sourceQuality": [],
       "risks": []
     },
     "confidence": "low|medium|high",
     "finalAnswer": "A complete answer to the user, with citations where appropriate."
   }
 ```

### File seams

 ```text
   pi-extensions/fusion/index.ts        # registers /fusion
   pi-extensions/fusion/config.ts       # load + validate config
   pi-extensions/fusion/model-ref.ts    # parse/resolve provider/model refs
   pi-extensions/fusion/model-runner.ts # completeWithTools loop
   pi-extensions/fusion/prompts.ts      # panel + judge prompts
   pi-extensions/fusion/orchestrator.ts # run panel + judge
   pi-extensions/fusion/render.ts       # custom fusion-result renderer
 ```

 Flow:

 ```text
   /fusion command
     -> load fusion config
     -> validate models + auth through pi modelRegistry
     -> show indeterminate BorderedLoader
     -> run panel models in parallel
          each model has only web_search + webfetch
     -> run judge model with same tools
     -> parse judge JSON
     -> persist/display custom "fusion-result" message
 ```

 Use BorderedLoader rather than setWorkingIndicator, because this command is doing direct extension work, not normal pi assistant streaming.

 ### Config shape

Example config:

 ```json
   {
     "judge": "anthropic/claude-opus-4-8",
     "models": [
       "openai-codex/gpt-5-5",
       "anthropic/claude-opus-4-8",
       "openrouter/deepseek/deepseek-v4-pro"
     ],
     "maxToolCalls": 8,
     "maxCompletionTokens": 20000,
     "webSearch": {
       "numResults": 5,
       "textMaxCharacters": 5000,
       "excludedDomains": []
     },
     "webfetch": {
       "strategy": "smart",
       "maxChars": 30000,
       "blockedDomains": []
     }
   }
 ```

 Model refs should be parsed as:

 ```ts
   type ModelRef = string; // "provider/model-id-with-possible-slashes"

   function parseModelRef(ref: ModelRef): { provider: string; modelId: string } {
     const slash = ref.indexOf("/");
     if (slash <= 0 || slash === ref.length - 1) {
       throw new Error(`Expected provider/model, got ${ref}`);
     }

     return {
       provider: ref.slice(0, slash),
       modelId: ref.slice(slash + 1),
     };
   }
 ```

 Important because OpenRouter IDs may themselves contain /, e.g.:

 ```text
   openrouter/deepseek/deepseek-v4-pro
 ```

 The exact provider/model IDs should come from pi’s /model or pi --list-models.

 Core types

 ```ts
   type FusionStatus = "ok" | "degraded" | "error";

   interface FusionConfig {
     judge: ModelRef;
     models: ModelRef[];
     maxToolCalls: number;
     maxCompletionTokens?: number;
     reasoning?: {
       effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
       maxTokens?: number;
     };
     webSearch?: WebSearchPolicy;
     webfetch?: WebFetchPolicy;
   }

   interface PanelResponse {
     model: ModelRef;
     runId: string;
     status: "ok";
     content: string;
     elapsedMs: number;
     toolCalls: ToolUseSummary[];
   }

   interface FailedPanelResponse {
     model: ModelRef;
     runId: string;
     status: "error";
     error: string;
     elapsedMs: number;
   }

   interface FusionAnalysis {
     consensus: string[];
     contradictions: Array<{
       topic: string;
       stances: Array<{ model: ModelRef; stance: string }>;
       judgeAssessment: string;
     }>;
     partialCoverage: Array<{
       point: string;
       models: ModelRef[];
     }>;
     uniqueInsights: Array<{
       model: ModelRef;
       insight: string;
     }>;
     blindSpots: string[];
     sourceQuality: string[];
     risks: string[];
   }

   interface FusionJudgeOutput {
     analysis: FusionAnalysis;
     finalAnswer: string;
     confidence: "low" | "medium" | "high";
   }

   interface FusionResult {
     status: FusionStatus;
     prompt: string;
     judge: ModelRef;
     responses: Array<PanelResponse | FailedPanelResponse>;
     judgeOutput?: FusionJudgeOutput;
     error?: string;
   }
 ```

 ### Model/tool loop seam

 Do not spawn nested pi AgentSessions. Use @earendil-works/pi-ai complete() directly and implement a tiny bounded tool loop.

 Reason: this guarantees the inner models only see the two allowed tools.

 ```ts
   interface CompletionClient {
     complete(request: CompletionRequest): Promise<AssistantMessage>;
   }

   interface FusionTool {
     name: string;
     description: string;
     parameters: unknown;
     execute(call: ToolCall, signal: AbortSignal): Promise<ToolResultMessage>;
   }

   async function completeWithTools(args: {
     model: ResolvedModel;
     systemPrompt: string;
     userPrompt: string;
     tools: FusionTool[];
     maxToolCalls: number;
     signal: AbortSignal;
   }): Promise<ModelRunResult> {
     const messages: Message[] = [userMessage(args.userPrompt)];
     let callsUsed = 0;

     while (true) {
       const assistant = await complete(args.model.model, {
         systemPrompt: args.systemPrompt,
         messages,
         tools: args.tools.map(toAiTool),
       }, args.model.auth);

       messages.push(assistant);

       const calls = extractToolCalls(assistant);
       if (calls.length === 0 || assistant.stopReason !== "toolUse") {
         return toModelRunResult(assistant, messages, callsUsed);
       }

       if (callsUsed + calls.length > args.maxToolCalls) {
         messages.push(toolBudgetExceededMessage());
         continue;
       }

       const results = await Promise.all(
         calls.map((call) => executeAllowedTool(call, args.tools, args.signal)),
       );

       callsUsed += calls.length;
       messages.push(...results);
     }
   }
 ```

 Tool adapters should come from refactoring existing extensions:

 ```text
   pi-extensions/exa-search.ts      -> registers standalone exa_search
   pi-extensions/exa-search-core.ts -> reusable executeWebSearch()
   pi-extensions/webfetch.ts        -> registers standalone webfetch
   pi-extensions/webfetch-core.ts   -> reusable executeWebfetch()
 ```

 Inside fusion, expose the search adapter as web_search even if the standalone tool remains exa_search.

### Output from fusion is custom message rendered like assistant output

 ```ts
   interface FusionResultDetails {
     prompt: string;
     judge: ModelRef;
     models: ModelRef[];
     analysis: FusionAnalysis;
     panelResponses: PanelResponseSummary[];
     elapsedMs: number;
   }

   pi.registerMessageRenderer<FusionResultDetails>("fusion-result", (message, options, theme) => {
     return renderFusionMarkdownLikeAssistant(message.content, message.details, options, theme);
   });

   pi.sendMessage<FusionResultDetails>({
     customType: "fusion-result",
     content: result.finalAnswer,
     display: true,
     details: {
       prompt,
       judge,
       models,
       analysis,
       panelResponses,
       elapsedMs,
     },
   });
 ```

 TUI default view shows just:

 ```md
   [final judge answer]
 ```

 Expanded view shows:

 ```md
   Fusion details:
   - Judge: anthropic/...
   - Panel: openai/..., anthropic/..., openrouter/...
   - Consensus / contradictions / blind spots
 ```

 Basically “what was just printed” without relying on private APIs.
