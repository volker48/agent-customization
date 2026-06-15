import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import webfetchExtension from "../pi-extensions/webfetch.js";

const execFileAsync = promisify(execFile);
const RUN_BASELINE = process.env.WEBFETCH_BASELINE === "1";
const RUN_REAL = process.env.WEBFETCH_REAL !== "0";
const CURL_TIMEOUT_MS = 20_000;
const REPORT_PATH = process.env.WEBFETCH_BASELINE_REPORT;

type WebFetchParams = {
  url: string;
  maxChars?: number;
  mode?: "full" | "probe";
  strategy?: "direct" | "smart";
  accept?: string;
  headers?: Record<string, string>;
  raw?: boolean;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details?: { fullOutputPath?: string; [key: string]: unknown };
};

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: WebFetchParams, signal: AbortSignal) => Promise<ToolResult>;
};

type BaselineCase = {
  name: string;
  url: string;
  webfetch?: Omit<WebFetchParams, "url">;
  minSavingsPercent?: number;
};

type Capture = {
  ok: boolean;
  text: string;
  error?: string;
};

type Comparison = {
  name: string;
  url: string;
  curlTokens: number;
  webfetchTokens: number;
  savingsPercent: number;
  curlOk: boolean;
  webfetchOk: boolean;
  notes: string[];
};

type CaddyFixture = {
  baseUrl: string;
  close: () => Promise<void>;
};

let originalPrivateHostOverride: string | undefined;
let caddyFixture: CaddyFixture | undefined;
const cleanupPaths = new Set<string>();
const comparisons: Comparison[] = [];

function createMockPi() {
  let tool: RegisteredTool | undefined;
  const pi = {
    registerTool(def: RegisteredTool) {
      tool = def;
    },
  };

  return {
    pi,
    getTool() {
      if (!tool) throw new Error("webfetch tool was not registered");
      return tool;
    },
  };
}

function tokenCount(text: string): number {
  return estimateTokens({
    role: "toolResult",
    toolCallId: "baseline",
    toolName: "baseline",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  } as never);
}

function savingsPercent(curlTokens: number, webfetchTokens: number): number {
  if (curlTokens === 0) return webfetchTokens === 0 ? 0 : -100;
  return ((curlTokens - webfetchTokens) / curlTokens) * 100;
}

function outputText(result: ToolResult): string {
  return result.content.map((item) => item.text).join("\n");
}

function toText(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return typeof value === "string" ? value : "";
}

async function runCurl(url: string): Promise<Capture> {
  const args = ["--location", "--silent", "--show-error", "--max-time", "20", url];

  try {
    const { stdout, stderr } = await execFileAsync("curl", args, {
      timeout: CURL_TIMEOUT_MS,
      maxBuffer: 25 * 1024 * 1024,
      encoding: "utf8",
    });
    const diagnostics = stderr ? `\n[curl stderr]\n${stderr}` : "";
    return { ok: true, text: `${stdout}${diagnostics}` };
  } catch (error) {
    const err = error as Error & { stdout?: unknown; stderr?: unknown };
    return {
      ok: false,
      text: [toText(err.stdout), toText(err.stderr), err.message].filter(Boolean).join("\n"),
      error: err.message,
    };
  }
}

async function runWebfetch(tool: RegisteredTool, item: BaselineCase): Promise<Capture> {
  const result = await tool.execute(
    `baseline_${item.name}`,
    { url: item.url, ...item.webfetch },
    new AbortController().signal,
  );
  const fullOutputPath = result.details?.fullOutputPath;
  if (fullOutputPath) cleanupPaths.add(fullOutputPath);
  return { ok: result.isError !== true, text: outputText(result) };
}

async function compare(tool: RegisteredTool, item: BaselineCase): Promise<Comparison> {
  const [curl, webfetch] = await Promise.all([runCurl(item.url), runWebfetch(tool, item)]);
  const curlTokens = tokenCount(curl.text);
  const webfetchTokens = tokenCount(webfetch.text);
  const notes = [
    curl.error ? `curl: ${curl.error}` : undefined,
    webfetch.ok ? undefined : `webfetch: ${webfetch.text.split("\n").slice(0, 3).join(" / ")}`,
  ].filter(Boolean) as string[];

  return {
    name: item.name,
    url: item.url,
    curlTokens,
    webfetchTokens,
    savingsPercent: savingsPercent(curlTokens, webfetchTokens),
    curlOk: curl.ok,
    webfetchOk: webfetch.ok,
    notes,
  };
}

function syntheticCases(baseUrl: string): BaselineCase[] {
  return [
    {
      name: "synthetic article with chrome",
      url: `${baseUrl}/article.html`,
      minSavingsPercent: 50,
    },
    {
      name: "synthetic JS shell with markdown alternate",
      url: `${baseUrl}/spa.html`,
      webfetch: { strategy: "smart" },
      minSavingsPercent: 40,
    },
    { name: "synthetic large text truncation", url: `${baseUrl}/huge.txt`, minSavingsPercent: 70 },
  ];
}

function realCases(): BaselineCase[] {
  return [
    { name: "real Hacker News", url: "https://news.ycombinator.com/news" },
    { name: "real Wikipedia article", url: "https://en.wikipedia.org/wiki/Caddy_(web_server)" },
    {
      name: "real MDN reference",
      url: "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
    },
    { name: "real Node.js docs", url: "https://nodejs.org/api/fs.html" },
  ];
}

function markdownReport(rows: Comparison[]): string {
  const header = [
    "# webfetch vs curl token baseline",
    "",
    "Token counts use pi's estimateTokens chars/4 heuristic. The curl baseline is raw stdout, " +
      "which favors curl because Pi's bash tool would add its own wrapper text.",
    "",
    "| Case | curl tokens | webfetch tokens | Savings | Result |",
    "| --- | ---: | ---: | ---: | --- |",
  ];
  const body = rows.map((row) => {
    const result = row.webfetchOk && row.curlOk ? "ok" : "check notes";
    return `| ${row.name} | ${row.curlTokens} | ${row.webfetchTokens} | ${row.savingsPercent.toFixed(1)}% | ${result} |`;
  });
  const notes = rows.flatMap((row) => row.notes.map((note) => `- ${row.name}: ${note}`));
  return [...header, ...body, "", ...notes].join("\n");
}

async function writeReport(rows: Comparison[]): Promise<void> {
  const report = markdownReport(rows);
  console.log(`\n${report}\n`);
  if (REPORT_PATH) await writeFile(REPORT_PATH, `${report}\n`);
}

async function hasCaddy(): Promise<boolean> {
  try {
    await execFileAsync("caddy", ["version"]);
    return true;
  } catch {
    return false;
  }
}

async function fixtureFiles(root: string): Promise<void> {
  const articleNoise = "<nav>" + "<a href='/x'>navigation noise</a>".repeat(300) + "</nav>";
  const articleBody = Array.from(
    { length: 45 },
    (_, index) => `<p>Paragraph ${index} explains the release, migration steps, and caveats.</p>`,
  ).join("");
  const shellScripts = Array.from(
    { length: 180 },
    (_, index) => `<script src='/static/chunk-${index}.js'></script>`,
  ).join("");
  const shell = [
    "<!doctype html><html><head><title>App</title>",
    shellScripts,
    `<script>window.__NEXT_DATA__={${'"payload":'.repeat(300)}"done"}</script>`,
    "</head><body><div id='root'></div><noscript>This app requires JavaScript.</noscript>",
    "</body></html>",
  ].join("");

  await writeFile(
    join(root, "article.html"),
    `<!doctype html><html><body>${articleNoise}<main><article><h1>Release notes</h1>${articleBody}</article></main><script>${"x=1;".repeat(500)}</script></body></html>`,
  );
  await writeFile(join(root, "spa.html"), shell);
  await writeFile(
    join(root, "spa.md"),
    "# App documentation\n\nUse the HTTP API, configure auth, then inspect logs.\n",
  );
  await writeFile(
    join(root, "huge.txt"),
    Array.from({ length: 12_000 }, (_, i) => `line-${i}: ${"payload ".repeat(12)}`).join("\n"),
  );
}

async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function waitForServer(url: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url);
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Caddy did not become ready at ${url}`);
}

async function startCaddyFixture(): Promise<CaddyFixture> {
  const root = await mkdtemp(join(tmpdir(), "webfetch-baseline-fixture-"));
  await fixtureFiles(root);
  const port = await freePort();
  const configPath = join(root, "Caddyfile");
  const config = [
    `{`,
    `  admin off`,
    `}`,
    `http://127.0.0.1:${port} {`,
    `  root * ${JSON.stringify(root)}`,
    `  header /spa.html Link "</spa.md>; rel=\\"alternate\\"; type=\\"text/markdown\\""`,
    `  file_server`,
    `}`,
  ].join("\n");
  await writeFile(configPath, config);

  const child = execFile("caddy", ["run", "--config", configPath, "--adapter", "caddyfile"]);
  child.stdout?.resume();
  child.stderr?.resume();
  await waitForServer(`http://127.0.0.1:${port}/article.html`);

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      child.kill("SIGTERM");
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe.skipIf(!RUN_BASELINE)("webfetch token baseline", () => {
  beforeAll(async () => {
    originalPrivateHostOverride = process.env.WEBFETCH_ALLOW_PRIVATE_HOSTS;
    process.env.WEBFETCH_ALLOW_PRIVATE_HOSTS = "1";
    if (!(await hasCaddy())) throw new Error("caddy is required for webfetch baseline");
    caddyFixture = await startCaddyFixture();
  }, 30_000);

  afterAll(async () => {
    await writeReport(comparisons);
    await caddyFixture?.close();
    await Promise.all(
      [...cleanupPaths].map((path) => rm(dirname(path), { recursive: true, force: true })),
    );

    if (originalPrivateHostOverride === undefined) delete process.env.WEBFETCH_ALLOW_PRIVATE_HOSTS;
    else process.env.WEBFETCH_ALLOW_PRIVATE_HOSTS = originalPrivateHostOverride;
  });

  it("beats curl on synthetic Caddy fixtures", async () => {
    if (!caddyFixture) throw new Error("Caddy fixture was not started");
    const { pi, getTool } = createMockPi();
    webfetchExtension(pi as never);

    for (const item of syntheticCases(caddyFixture.baseUrl)) {
      const row = await compare(getTool(), item);
      comparisons.push(row);
      expect(row.webfetchOk, row.name).toBe(true);
      expect(row.savingsPercent, row.name).toBeGreaterThanOrEqual(item.minSavingsPercent ?? 0);
    }
  }, 60_000);

  it.skipIf(!RUN_REAL)(
    "records real website comparisons",
    async () => {
      const { pi, getTool } = createMockPi();
      webfetchExtension(pi as never);

      for (const item of realCases()) {
        comparisons.push(await compare(getTool(), item));
      }
    },
    120_000,
  );
});
