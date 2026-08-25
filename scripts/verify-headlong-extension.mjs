#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { HeadlongStore } from "../pi-extensions/headlong/store.ts";
import { runPiRpcChild, runSupervisorWake } from "../pi-extensions/headlong/supervisor.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(repositoryRoot, "pi-extensions", "headlong", "index.ts");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Headlong verifier state");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

async function verify() {
  const root = await mkdtemp(join(tmpdir(), "headlong-pinned-pi-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const stateRoot = join(root, "state");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(sessionDir, { recursive: true }),
  ]);
  const previousStateRoot = process.env.PI_HEADLONG_STATE_ROOT;
  process.env.PI_HEADLONG_STATE_ROOT = stateRoot;
  let session;
  try {
    const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const packageJson = JSON.parse(
      await readFile(join(dirname(packageEntry), "..", "package.json"), "utf8"),
    );
    assert(packageJson.version === "0.84.2", `Expected Pi 0.84.2, got ${packageJson.version}`);

    const faux = fauxProvider({ provider: "headlong-verifier", tokensPerSecond: 100_000 });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("headlong_complete", { summary: "Pinned Pi verifier completed" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Headlong verifier done.", { stopReason: "stop" }),
    ]);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);

    const loader = new DefaultResourceLoader({
      cwd: workspace,
      agentDir,
      additionalExtensionPaths: [extensionPath],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert(loaded.errors.length === 0, `Extension loader errors: ${JSON.stringify(loaded.errors)}`);
    assert(loaded.extensions.length === 1, `Expected one loaded extension, got ${loaded.extensions.length}`);
    console.log(`[headlong-verify] Pi ${packageJson.version} extension loaded`);

    const sessionManager = SessionManager.create(workspace, sessionDir);
    const created = await createAgentSession({
      cwd: workspace,
      agentDir,
      modelRuntime,
      model: faux.getModel(),
      resourceLoader: loader,
      sessionManager,
    });
    session = created.session;
    const extensionErrors = [];
    await session.bindExtensions({
      onError: (error) => extensionErrors.push(error),
    });
    const toolNames = session.getAllTools().map((tool) => tool.name);
    for (const name of [
      "headlong_checkpoint",
      "headlong_sleep",
      "headlong_complete",
      "headlong_blocked",
    ]) {
      assert(toolNames.includes(name), `Pinned Pi did not register ${name}`);
    }

    await session.prompt("/headlong start");
    const store = new HeadlongStore({ stateRoot, workspace });
    let completed;
    try {
      completed = await waitFor(async () => {
        const state = await store.readState();
        return state?.status === "completed" ? state : undefined;
      });
    } catch (error) {
      const state = await store.readState();
      let events = "missing";
      try {
        events = await readFile(store.eventsPath, "utf8");
      } catch {}
      throw new Error(
        `Pinned Pi did not complete Headlong wake. state=${JSON.stringify(state)} events=${events}`,
        { cause: error },
      );
    }
    await session.waitForIdle();
    assert(completed.lastTransitionWakeId?.startsWith("wake-"), "Missing durable wake transition");
    assert(completed.sessionFile === session.sessionFile, "Actor did not retain canonical Pi session");
    assert(extensionErrors.length === 0, `Extension errors: ${JSON.stringify(extensionErrors)}`);
    const trajectory = await readFile(session.sessionFile, "utf8");
    assert(trajectory.includes('"type":"message"'), "Canonical Pi JSONL did not persist messages");
    console.log(`[headlong-verify] durable tool transition: ${completed.status}`);

    const providerExtensionPath = join(root, "headlong-faux-provider.mjs");
    const piAiEntry = import.meta.resolve("@earendil-works/pi-ai");
    await writeFile(
      providerExtensionPath,
      `import { fauxAssistantMessage, fauxProvider, fauxToolCall } from ${JSON.stringify(piAiEntry)};
export default function registerHeadlongVerifierProvider(pi) {
  const faux = fauxProvider({ provider: "headlong-verifier", tokensPerSecond: 100000 });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("headlong_complete", { summary: "Real RPC supervisor child completed" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Headlong supervisor verifier done.", { stopReason: "stop" }),
  ]);
  pi.registerProvider(faux.provider);
}
`,
      "utf8",
    );
    const dueAt = new Date().toISOString();
    await store.writeState({
      ...completed,
      revision: completed.revision + 1,
      status: "sleeping",
      wakeAt: dueAt,
      activeWakeId: null,
      wakeStartedAt: null,
      updatedAt: dueAt,
    });
    let supervisorResult;
    let callbackRan = false;
    await session.reload({
      beforeSessionStart: async () => {
        callbackRan = true;
        supervisorResult = await runSupervisorWake({
          store,
          extensionPath,
          timeoutMs: 10_000,
          runChild: async (request) => {
            try {
              return await runPiRpcChild(request, {
                command: process.execPath,
                prefixArgs: [
                  join(dirname(packageEntry), "cli.js"),
                  "--extension",
                  providerExtensionPath,
                  "--model",
                  "headlong-verifier/faux-1",
                  "--approve",
                  "--offline",
                ],
              });
            } catch (error) {
              console.error(
                `[headlong-verify] RPC child error: ${error instanceof Error ? error.message : String(error)}`,
              );
              throw error;
            }
          },
        });
      },
    });
    assert(callbackRan, "Pinned Pi reload did not expose beforeSessionStart lifecycle boundary");
    assert(
      supervisorResult?.kind === "transitioned",
      `Real RPC supervisor child did not transition: ${JSON.stringify(supervisorResult)}`,
    );
    assert(extensionErrors.length === 0, `Reload extension errors: ${JSON.stringify(extensionErrors)}`);
    console.log(`[headlong-verify] real RPC supervisor child: ${supervisorResult.kind}`);
    console.log("[headlong-verify] PASS");
  } finally {
    session?.dispose();
    if (previousStateRoot === undefined) delete process.env.PI_HEADLONG_STATE_ROOT;
    else process.env.PI_HEADLONG_STATE_ROOT = previousStateRoot;
    await rm(root, { recursive: true, force: true });
  }
}

verify().catch((error) => {
  console.error(`[headlong-verify] FAILURE: ${error instanceof Error ? error.stack : String(error)}`);
  process.exitCode = 1;
});
