import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPiRpcArguments,
  runPiRpcChild,
  runSupervisorLoop,
  runSupervisorWake,
  terminateProcessGroup,
} from "../pi-extensions/headlong/supervisor.js";
import { ActorLease } from "../pi-extensions/headlong/lease.js";
import {
  HeadlongStore,
  createInitialActorState,
  type HeadlongActorState,
} from "../pi-extensions/headlong/store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function dueStore(root: string, now: number): Promise<HeadlongStore> {
  const workspace = join(root, "workspace");
  const store = new HeadlongStore({ stateRoot: join(root, "state"), workspace });
  const initial = createInitialActorState({
    workspace,
    sessionFile: join(root, "session.jsonl"),
    sessionId: "session-1",
    now,
  });
  await store.writeState({
    ...initial,
    revision: 1,
    status: "sleeping",
    wakeAt: new Date(now).toISOString(),
  });
  return store;
}

describe("Headlong wake-after-exit supervisor", () => {
  it("owns one due wake and accepts only its explicit durable transition", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-supervisor-wake-"));
    roots.push(root);
    const now = 1_787_680_000_000;
    const store = await dueStore(root, now);
    const runChild = vi.fn(async (request: { wakeId: string; leaseToken: string }) => {
      const active = await store.readState();
      expect(active).toMatchObject({ status: "running", activeWakeId: request.wakeId });
      await store.writeState({
        ...(active as HeadlongActorState),
        revision: (active as HeadlongActorState).revision + 1,
        status: "completed",
        wakeAt: null,
        activeWakeId: null,
        wakeStartedAt: null,
        lastTransitionWakeId: request.wakeId,
        updatedAt: new Date(now + 1).toISOString(),
      });
      return { settled: true, timedOut: false, exitCode: 0 };
    });

    const result = await runSupervisorWake({
      store,
      now: () => now,
      extensionPath: join(process.cwd(), "pi-extensions/headlong/index.ts"),
      runChild,
    });

    expect(result).toMatchObject({ kind: "transitioned", status: "completed" });
    expect(runChild).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionFile: join(root, "session.jsonl"),
        workspace: join(root, "workspace"),
        leaseToken: expect.any(String),
        prompt: expect.stringContaining("HEADLONG WAKE"),
      }),
    );
  });

  it.each(["stopped", "completed"] as const)(
    "preserves a durable terminal %s transition when the Pi child later fails",
    async (terminalStatus) => {
      const root = await mkdtemp(join(tmpdir(), `headlong-supervisor-terminal-${terminalStatus}-`));
      roots.push(root);
      const now = 1_787_680_000_000;
      const store = await dueStore(root, now);

      const result = await runSupervisorWake({
        store,
        now: () => now,
        extensionPath: join(process.cwd(), "pi-extensions/headlong/index.ts"),
        runChild: async (request) => {
          const active = (await store.readState()) as HeadlongActorState;
          await store.writeState({
            ...active,
            revision: active.revision + 1,
            status: terminalStatus,
            wakeAt: null,
            activeWakeId: null,
            wakeStartedAt: null,
            lastTransitionWakeId: request.wakeId,
            updatedAt: new Date(now + 1).toISOString(),
          });
          return { settled: true, timedOut: false, exitCode: 1 };
        },
      });

      expect(result).toMatchObject({ kind: "failed-closed" });
      await expect(store.readState()).resolves.toMatchObject({
        status: terminalStatus,
        activeWakeId: null,
      });
    },
  );

  it("revalidates due status after lease acquisition before dispatching", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-supervisor-revalidate-"));
    roots.push(root);
    const now = 1_787_680_000_000;
    const store = await dueStore(root, now);
    const originalReadState = store.readState.bind(store);
    let readCount = 0;
    vi.spyOn(store, "readState").mockImplementation(async () => {
      const state = await originalReadState();
      readCount += 1;
      if (readCount === 1 && state) {
        await store.writeState({
          ...state,
          revision: state.revision + 1,
          status: "paused",
          wakeAt: null,
          updatedAt: new Date(now + 1).toISOString(),
        });
      }
      return state;
    });
    const runChild = vi.fn();

    const result = await runSupervisorWake({
      store,
      extensionPath: join(process.cwd(), "pi-extensions/headlong/index.ts"),
      now: () => now + 2,
      runChild,
    });

    expect(result).toEqual({ kind: "not-due", status: "paused" });
    expect(runChild).not.toHaveBeenCalled();
    await expect(originalReadState()).resolves.toMatchObject({ status: "paused", activeWakeId: null });
  });

  it("recovers an interrupted active wake with bounded failure backoff before launching again", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-supervisor-interrupted-"));
    roots.push(root);
    const now = 1_787_680_000_000;
    const store = await dueStore(root, now);
    const state = (await store.readState()) as HeadlongActorState;
    await store.writeState({
      ...state,
      revision: state.revision + 1,
      status: "running",
      wakeAt: null,
      activeWakeId: "wake-from-dead-host",
      wakeStartedAt: new Date(now - 60_000).toISOString(),
      updatedAt: new Date(now - 60_000).toISOString(),
    });
    const runChild = vi.fn();

    const result = await runSupervisorWake({
      store,
      now: () => now,
      extensionPath: join(process.cwd(), "pi-extensions/headlong/index.ts"),
      runChild,
    });

    expect(runChild).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "failed-closed", reason: expect.stringContaining("interrupted") });
    await expect(store.readState()).resolves.toMatchObject({
      status: "sleeping",
      wakeAt: new Date(now + 5_000).toISOString(),
      activeWakeId: null,
      consecutiveFailures: 1,
    });
  });

  it("pauses when Pi settles without the required explicit durable transition", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-supervisor-settled-"));
    roots.push(root);
    const now = 1_787_680_000_000;
    const store = await dueStore(root, now);

    const result = await runSupervisorWake({
      store,
      now: () => now,
      extensionPath: join(process.cwd(), "pi-extensions/headlong/index.ts"),
      runChild: async () => ({ settled: true, timedOut: false, exitCode: 0 }),
    });

    expect(result).toMatchObject({
      kind: "failed-closed",
      reason: "wake settled without explicit transition",
    });
    await expect(store.readState()).resolves.toMatchObject({
      status: "paused",
      activeWakeId: null,
      consecutiveFailures: 1,
    });
  });

  it("fails closed durably when the supervised Pi child rejects before settlement", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-supervisor-child-error-"));
    roots.push(root);
    const now = 1_787_680_000_000;
    const store = await dueStore(root, now);

    const result = await runSupervisorWake({
      store,
      now: () => now,
      extensionPath: join(process.cwd(), "pi-extensions/headlong/index.ts"),
      runChild: async () => {
        throw new Error("malformed RPC output");
      },
    });

    expect(result).toMatchObject({
      kind: "failed-closed",
      reason: "Pi child failed before the wake settled",
    });
    await expect(store.readState()).resolves.toMatchObject({
      status: "paused",
      activeWakeId: null,
      consecutiveFailures: 1,
    });
  });

  it("terminates the entire detached Pi process group on timeout", async () => {
    if (process.platform === "win32") return;
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const {spawn}=require("node:child_process");
         const nested=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});
         console.log(nested.pid); setInterval(()=>{},1000);`,
      ],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const [chunk] = (await once(child.stdout, "data")) as [Buffer];
    const nestedPid = Number(chunk.toString("utf8").trim());
    expect(Number.isSafeInteger(nestedPid)).toBe(true);

    await terminateProcessGroup(child, { graceMs: 100 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive(child.pid as number)).toBe(false);
    expect(alive(nestedPid)).toBe(false);
  });

  it("waits without overlap until the original live host exits, then wakes the stored session", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-supervisor-loop-"));
    roots.push(root);
    const now = 1_787_680_000_000;
    const store = await dueStore(root, now);
    const host = await ActorLease.acquire({ store, role: "live-host" });
    expect(host).toBeDefined();
    let sleepCount = 0;
    const runChild = vi.fn(async (request: { wakeId: string }) => {
      const active = (await store.readState()) as HeadlongActorState;
      await store.writeState({
        ...active,
        revision: active.revision + 1,
        status: "completed",
        activeWakeId: null,
        wakeStartedAt: null,
        lastTransitionWakeId: request.wakeId,
        updatedAt: new Date(now + 1).toISOString(),
      });
      return { settled: true, timedOut: false, exitCode: 0 };
    });

    const result = await runSupervisorLoop({
      store,
      now: () => now,
      extensionPath: join(process.cwd(), "pi-extensions/headlong/index.ts"),
      runChild,
      maxIterations: 3,
      sleep: async () => {
        sleepCount += 1;
        await host?.release();
      },
    });

    expect(sleepCount).toBe(1);
    expect(runChild).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ kind: "terminal", status: "completed" });
  });

  it("loads Headlong and PRO-LONG explicitly while retaining repository context files", () => {
    const extensionPath = join(process.cwd(), "pi-extensions/headlong/index.ts");
    const arguments_ = buildPiRpcArguments(
      {
        wakeId: "wake-rpc",
        leaseToken: "lease-token",
        sessionFile: "/tmp/session.jsonl",
        workspace: "/tmp/workspace",
        extensionPath,
        stateRoot: "/tmp/state",
        prompt: "HEADLONG WAKE wake-rpc",
        timeoutMs: 2_000,
      },
      ["pi-cli.js"],
    );

    expect(arguments_).toContain("--no-extensions");
    expect(arguments_).not.toContain("--no-context-files");
    expect(arguments_).toEqual(
      expect.arrayContaining([
        "--extension",
        extensionPath,
        "--extension",
        join(process.cwd(), "pi-extensions/prolong.ts"),
      ]),
    );
  });

  it("speaks the pinned Pi newline-delimited RPC settlement protocol in a detached child", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-supervisor-rpc-"));
    roots.push(root);
    const fixture = join(root, "rpc-fixture.mjs");
    await writeFile(
      fixture,
      `let data="";
       process.stdin.setEncoding("utf8");
       process.stdin.on("data",chunk=>{
         data+=chunk;
         const end=data.indexOf("\\n");
         if(end<0)return;
         const request=JSON.parse(data.slice(0,end));
         process.stdout.write(JSON.stringify({id:request.id,type:"response",command:"prompt",success:true})+"\\n");
         process.stdout.write(JSON.stringify({type:"agent_settled"})+"\\n");
       });
       process.stdin.on("end",()=>process.exit(0));`,
      "utf8",
    );

    const result = await runPiRpcChild(
      {
        wakeId: "wake-rpc",
        leaseToken: "lease-token",
        sessionFile: join(root, "session.jsonl"),
        workspace: root,
        extensionPath: join(process.cwd(), "pi-extensions/headlong/index.ts"),
        stateRoot: join(root, "state"),
        prompt: "HEADLONG WAKE wake-rpc",
        timeoutMs: 2_000,
      },
      { command: process.execPath, prefixArgs: [fixture] },
    );

    expect(result).toMatchObject({ settled: true, timedOut: false, exitCode: 0 });
  });

  it("waits for child close so inherited stdout can deliver settlement after process exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-supervisor-rpc-close-order-"));
    roots.push(root);
    const fixture = join(root, "rpc-close-order-fixture.mjs");
    await writeFile(
      fixture,
      `import { spawn } from "node:child_process";
let data="";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  data += chunk;
  const newline = data.indexOf("\\n");
  if (newline < 0) return;
  const request = JSON.parse(data.slice(0, newline));
  const script = "setTimeout(() => { process.stdout.write(JSON.stringify({id:" + JSON.stringify(request.id) + ",type:'response',command:'prompt',success:true}) + '\\\\n'); process.stdout.write(JSON.stringify({type:'agent_settled'}) + '\\\\n'); }, 30);";
  spawn(process.execPath, ["-e", script], { stdio: ["ignore", process.stdout, "ignore"] });
  setTimeout(() => process.exit(0), 5);
});
`,
      "utf8",
    );

    const result = await runPiRpcChild(
      {
        wakeId: "wake-rpc-close-order",
        leaseToken: "lease-token",
        sessionFile: join(root, "session.jsonl"),
        workspace: root,
        extensionPath: join(process.cwd(), "pi-extensions/headlong/index.ts"),
        stateRoot: join(root, "state"),
        prompt: "HEADLONG WAKE wake-rpc-close-order",
        timeoutMs: 2_000,
      },
      { command: process.execPath, prefixArgs: [fixture] },
    );

    expect(result).toMatchObject({ settled: true, timedOut: false, exitCode: 0 });
  });

  it("contains stdin EPIPE when the RPC child exits before accepting the prompt", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "headlong-supervisor-rpc-stdin-epipe-"));
    roots.push(root);
    const probe = join(root, "stdin-epipe-probe.mjs");
    const supervisorPath = join(process.cwd(), "pi-extensions/headlong/supervisor.ts");
    await writeFile(
      probe,
      `const { runPiRpcChild } = await import(${JSON.stringify(supervisorPath)});
await runPiRpcChild({
  wakeId: "probe",
  leaseToken: "placeholder",
  sessionFile: "/tmp/nonexistent.jsonl",
  workspace: process.cwd(),
  extensionPath: "/tmp/nonexistent.ts",
  stateRoot: "/tmp/headlong-epipe-probe",
  prompt: "probe",
  timeoutMs: 1000,
}, { command: "/bin/true", prefixArgs: [] });
`,
      "utf8",
    );
    const child = spawn(process.execPath, ["--import", "tsx", probe], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const [exitCode] = (await once(child, "close")) as [number | null];

    expect(exitCode).toBe(0);
  });

  it("rejects a same-id RPC response for a different command", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-supervisor-rpc-command-"));
    roots.push(root);
    const fixture = join(root, "rpc-command-fixture.mjs");
    await writeFile(
      fixture,
      `process.stdin.once("data",chunk=>{
         const request=JSON.parse(String(chunk).trim());
         process.stdout.write(JSON.stringify({id:request.id,type:"response",command:"get_state",success:true})+"\\n");
         process.stdout.write(JSON.stringify({type:"agent_settled"})+"\\n");
       });
       process.stdin.on("end",()=>process.exit(0));`,
      "utf8",
    );

    await expect(
      runPiRpcChild(
        {
          wakeId: "wake-rpc-command",
          leaseToken: "lease-token",
          sessionFile: join(root, "session.jsonl"),
          workspace: root,
          extensionPath: join(process.cwd(), "pi-extensions/headlong/index.ts"),
          stateRoot: join(root, "state"),
          prompt: "HEADLONG WAKE wake-rpc-command",
          timeoutMs: 2_000,
        },
        { command: process.execPath, prefixArgs: [fixture] },
      ),
    ).rejects.toThrow(/prompt response/i);
  });

  it("rejects a truncated trailing RPC frame after settlement", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-supervisor-rpc-truncated-tail-"));
    roots.push(root);
    const fixture = join(root, "rpc-truncated-tail-fixture.mjs");
    await writeFile(
      fixture,
      `let data="";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  data += chunk;
  const newline = data.indexOf("\\n");
  if (newline < 0) return;
  const request = JSON.parse(data.slice(0, newline));
  process.stdout.write(JSON.stringify({ id: request.id, type: "response", command: "prompt", success: true }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
  process.stdout.write('{"type":"extension_error"');
  setTimeout(() => process.exit(0), 25);
});
`,
      "utf8",
    );

    await expect(
      runPiRpcChild(
        {
          wakeId: "wake-rpc-truncated-tail",
          leaseToken: "lease-rpc-truncated-tail",
          sessionFile: join(root, "session.jsonl"),
          workspace: root,
          extensionPath: join(root, "headlong.ts"),
          stateRoot: join(root, "state"),
          prompt: "HEADLONG WAKE wake-rpc-truncated-tail",
          timeoutMs: 5_000,
        },
        { command: process.execPath, prefixArgs: [fixture] },
      ),
    ).rejects.toThrow(/unterminated|truncated/i);
  });

  it("rejects an extension_error frame even after the prompt was accepted", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-supervisor-rpc-extension-error-"));
    roots.push(root);
    const fixture = join(root, "rpc-extension-error-fixture.mjs");
    await writeFile(
      fixture,
      `process.stdin.once("data",chunk=>{
         const request=JSON.parse(String(chunk).trim());
         process.stdout.write(JSON.stringify({id:request.id,type:"response",command:"prompt",success:true})+"\\n");
         process.stdout.write(JSON.stringify({type:"extension_error",extensionPath:"headlong",event:"agent_end",error:"boom"})+"\\n");
         process.stdout.write(JSON.stringify({type:"agent_settled"})+"\\n");
       });
       process.stdin.on("end",()=>process.exit(0));`,
      "utf8",
    );

    await expect(
      runPiRpcChild(
        {
          wakeId: "wake-rpc-extension-error",
          leaseToken: "lease-token",
          sessionFile: join(root, "session.jsonl"),
          workspace: root,
          extensionPath: join(process.cwd(), "pi-extensions/headlong/index.ts"),
          stateRoot: join(root, "state"),
          prompt: "HEADLONG WAKE wake-rpc-extension-error",
          timeoutMs: 2_000,
        },
        { command: process.execPath, prefixArgs: [fixture] },
      ),
    ).rejects.toThrow(/extension error/i);
  });

  it("rejects an extension_error emitted after settlement but before clean child exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-supervisor-rpc-late-extension-error-"));
    roots.push(root);
    const fixture = join(root, "rpc-late-extension-error-fixture.mjs");
    await writeFile(
      fixture,
      `process.stdin.once("data",chunk=>{
         const request=JSON.parse(String(chunk).trim());
         process.stdout.write(JSON.stringify({id:request.id,type:"response",command:"prompt",success:true})+"\\n");
         process.stdout.write(JSON.stringify({type:"agent_settled"})+"\\n");
         setTimeout(()=>{
           process.stdout.write(JSON.stringify({type:"extension_error",extensionPath:"headlong",event:"agent_end",error:"late"})+"\\n");
           process.exit(0);
         },25);
       });`,
      "utf8",
    );

    await expect(
      runPiRpcChild(
        {
          wakeId: "wake-rpc-late-extension-error",
          leaseToken: "lease-token",
          sessionFile: join(root, "session.jsonl"),
          workspace: root,
          extensionPath: join(process.cwd(), "pi-extensions/headlong/index.ts"),
          stateRoot: join(root, "state"),
          prompt: "HEADLONG WAKE wake-rpc-late-extension-error",
          timeoutMs: 2_000,
        },
        { command: process.execPath, prefixArgs: [fixture] },
      ),
    ).rejects.toThrow(/extension error/i);
  });

  it.each(["error", "aborted"] as const)(
    "rejects an agent_end terminal %s outcome",
    async (stopReason) => {
      const root = await mkdtemp(join(tmpdir(), `headlong-supervisor-rpc-${stopReason}-`));
      roots.push(root);
      const fixture = join(root, "rpc-terminal-fixture.mjs");
      await writeFile(
        fixture,
        `process.stdin.once("data",chunk=>{
           const request=JSON.parse(String(chunk).trim());
           process.stdout.write(JSON.stringify({id:request.id,type:"response",command:"prompt",success:true})+"\\n");
           process.stdout.write(JSON.stringify({type:"agent_end",messages:[{role:"assistant",stopReason:${JSON.stringify(stopReason)},isError:true}]})+"\\n");
           process.stdout.write(JSON.stringify({type:"agent_settled"})+"\\n");
         });
         process.stdin.on("end",()=>process.exit(0));`,
        "utf8",
      );

      await expect(
        runPiRpcChild(
          {
            wakeId: `wake-rpc-${stopReason}`,
            leaseToken: "lease-token",
            sessionFile: join(root, "session.jsonl"),
            workspace: root,
            extensionPath: join(process.cwd(), "pi-extensions/headlong/index.ts"),
            stateRoot: join(root, "state"),
            prompt: `HEADLONG WAKE wake-rpc-${stopReason}`,
            timeoutMs: 2_000,
          },
          { command: process.execPath, prefixArgs: [fixture] },
        ),
      ).rejects.toThrow(new RegExp(stopReason, "i"));
    },
  );

  it("rejects an accepted settlement when the Pi child exits nonzero", async () => {
    const root = await mkdtemp(join(tmpdir(), "headlong-supervisor-rpc-nonzero-"));
    roots.push(root);
    const fixture = join(root, "rpc-nonzero-fixture.mjs");
    await writeFile(
      fixture,
      `let data="";
       process.stdin.setEncoding("utf8");
       process.stdin.on("data",chunk=>{
         data+=chunk;
         const end=data.indexOf("\\n");
         if(end<0)return;
         const request=JSON.parse(data.slice(0,end));
         process.stdout.write(JSON.stringify({id:request.id,type:"response",command:"prompt",success:true})+"\\n");
         process.stdout.write(JSON.stringify({type:"agent_settled"})+"\\n");
       });
       process.stdin.on("end",()=>process.exit(42));`,
      "utf8",
    );

    const result = await runPiRpcChild(
      {
        wakeId: "wake-rpc-nonzero",
        leaseToken: "lease-token",
        sessionFile: join(root, "session.jsonl"),
        workspace: root,
        extensionPath: join(process.cwd(), "pi-extensions/headlong/index.ts"),
        stateRoot: join(root, "state"),
        prompt: "HEADLONG WAKE wake-rpc-nonzero",
        timeoutMs: 2_000,
      },
      { command: process.execPath, prefixArgs: [fixture] },
    );

    expect(result).toMatchObject({ settled: false, timedOut: false, exitCode: 42 });
  });

  it("terminates a detached Pi process group when RPC protocol validation fails", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "headlong-supervisor-rpc-error-"));
    roots.push(root);
    const fixture = join(root, "rpc-error-fixture.mjs");
    const pidPath = join(root, "child.pid");
    await writeFile(
      fixture,
      `import { writeFileSync } from "node:fs";
       writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
       process.stdin.once("data", () => {
         process.stdout.write("not-json\\n");
         setInterval(() => {}, 1000);
       });`,
      "utf8",
    );

    await expect(
      runPiRpcChild(
        {
          wakeId: "wake-rpc-error",
          leaseToken: "lease-token",
          sessionFile: join(root, "session.jsonl"),
          workspace: root,
          extensionPath: join(process.cwd(), "pi-extensions/headlong/index.ts"),
          stateRoot: join(root, "state"),
          prompt: "HEADLONG WAKE wake-rpc-error",
          timeoutMs: 2_000,
        },
        { command: process.execPath, prefixArgs: [fixture] },
      ),
    ).rejects.toThrow(/malformed JSON/);

    const pid = Number(await readFile(pidPath, "utf8"));
    let wasAlive = false;
    try {
      process.kill(pid, 0);
      wasAlive = true;
      process.kill(-pid, "SIGKILL");
    } catch {}
    expect(wasAlive).toBe(false);
  });

  it("aborts and terminates the detached Pi process group on supervisor shutdown", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "headlong-supervisor-rpc-abort-"));
    roots.push(root);
    const fixture = join(root, "rpc-abort-fixture.mjs");
    const pidPath = join(root, "child.pid");
    await writeFile(
      fixture,
      `import { writeFileSync } from "node:fs";
       writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
       process.stdin.once("data", () => setInterval(() => {}, 1000));`,
      "utf8",
    );
    const controller = new AbortController();
    const childResult = runPiRpcChild(
      {
        wakeId: "wake-rpc-abort",
        leaseToken: "lease-token",
        sessionFile: join(root, "session.jsonl"),
        workspace: root,
        extensionPath: join(process.cwd(), "pi-extensions/headlong/index.ts"),
        stateRoot: join(root, "state"),
        prompt: "HEADLONG WAKE wake-rpc-abort",
        timeoutMs: 500,
        signal: controller.signal,
      },
      { command: process.execPath, prefixArgs: [fixture] },
    );
    await vi.waitFor(async () => expect(Number(await readFile(pidPath, "utf8"))).toBeGreaterThan(0));
    controller.abort();

    await expect(childResult).resolves.toMatchObject({
      settled: false,
      timedOut: false,
      aborted: true,
    });
    const pid = Number(await readFile(pidPath, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
