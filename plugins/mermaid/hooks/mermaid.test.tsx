import { describe, expect, mock, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";

import { splitMermaid } from "./register";

const DIAGRAM = "sequenceDiagram\n  A->>B: hi";
const REPLY = `Before.\n\n\`\`\`mermaid\n${DIAGRAM}\n\`\`\`\n\nAfter.`;

/** A PNG header whose IHDR says 1600 by 400 pixels: all the mod reads. */
const PNG_HEAD = btoa(
  "\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR" + "\x00\x00\x06\x40" + "\x00\x00\x01\x90",
);

const CACHE = "/Users/test/.cache/claude-mermaid";
const IS_CACHED_PNG = /^\/Users\/test\/\.cache\/claude-mermaid\/[0-9a-f]{64}\.png$/;

type HostOptions = {
  /** merman-cli exits 2 with a parse error, leaving a partial file behind. */
  isParseError?: boolean;
  /** How many merman-cli runs reject first, as when it cannot start or times out. */
  mermanRejects?: number;
  /** How many `mkdir` runs fail first. */
  mkdirFails?: number;
  /** Cached PNG paths already hold a truncated file from an interrupted render. */
  isCacheStale?: boolean;
};

/**
 * Fakes merman-cli, mkdir, mv, rm and a file system beneath the plugin.
 *
 * Returns the merman-cli argvs run and the files as they stand.
 */
function fakeHost(on: On, options: HostOptions = {}) {
  let { mermanRejects = 0, mkdirFails = 0 } = options;
  const renders: (readonly string[])[] = [];
  const files = new Map<string, string>();
  const toasts: string[] = [];
  const ran = (exitCode: number, stderr = "") => ({
    value: { exitCode, stdout: "", stderr, isStdoutTruncated: false, isStderrTruncated: false },
  });

  mock.env(on, { HOME: "/Users/test" });
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>drawn by the engine</Text>;
  });
  on("config.list", () => ({ value: [] }));
  on("ui.toast", (_$, e) => {
    toasts.push(e.text);
    return { value: undefined };
  });
  on("process.run", (_$, e) => {
    const [command, ...args] = e.argv;
    if (command === "mkdir") return mkdirFails-- > 0 ? ran(1, "Permission denied") : ran(0);
    if (command === "rm") {
      for (const path of args.filter((arg) => !arg.startsWith("-"))) files.delete(path);
      return ran(0);
    }
    if (command === "mv") {
      const [from, to] = args.filter((arg) => !arg.startsWith("-"));
      const content = from === undefined ? undefined : files.get(from);
      if (from === undefined || to === undefined || content === undefined) return ran(1);
      files.set(to, content);
      files.delete(from);
      return ran(0);
    }
    renders.push(e.argv);
    if (mermanRejects-- > 0) return { deny: "merman-cli: command not found" };
    const output = e.argv[e.argv.indexOf("-o") + 1] ?? "";
    if (!output.endsWith(".png"))
      return ran(2, `cannot infer a compiled output format from "${output}"`);
    if (options.isParseError === true) {
      files.set(output, btoa("\x89PN"));
      return ran(2, "Parse error on line 2");
    }
    files.set(output, PNG_HEAD);
    return ran(0);
  });
  on("fs.read", (_$, e) => {
    const content = files.get(e.path);
    if (content !== undefined) return { value: { base64: content } };
    if (options.isCacheStale === true && IS_CACHED_PNG.test(e.path)) {
      return { value: { base64: btoa("\x89PNG\r\n") } };
    }
    return { deny: `ENOENT: ${e.path}` };
  });
  return { renders, files, toasts };
}

function mountReply($: Engine, text: string, surface: "terminal" | "desktop" = "terminal") {
  return $.ui.mount({
    plugin: "mermaid",
    surface,
    component: "AssistantMessage",
    props: { text, isFirstOfReply: true },
    viewport: { columns: 120, rows: 40 },
  });
}

describe("splitMermaid", () => {
  test("splits prose and a closed mermaid fence", () => {
    expect(splitMermaid(REPLY)).toEqual([
      { kind: "markdown", text: "Before.\n" },
      { kind: "mermaid", source: DIAGRAM, raw: `\`\`\`mermaid\n${DIAGRAM}\n\`\`\`` },
      { kind: "markdown", text: "\nAfter." },
    ]);
  });

  test("leaves an unclosed fence as prose while the reply streams", () => {
    const streaming = `Before.\n\n\`\`\`mermaid\n${DIAGRAM}`;
    expect(splitMermaid(streaming)).toEqual([{ kind: "markdown", text: streaming }]);
  });

  test("leaves a mermaid fence nested in a longer fence as prose", () => {
    const nested = `\`\`\`\`markdown\n\`\`\`mermaid\n${DIAGRAM}\n\`\`\`\n\`\`\`\``;
    expect(splitMermaid(nested)).toEqual([{ kind: "markdown", text: nested }]);
  });
});

describe("AssistantMessage", () => {
  test("draws a closed mermaid fence as an image between the prose", async ($, on) => {
    const { renders } = fakeHost(on);
    const ui = await mountReply($, REPLY);

    expect(await ui.find({ type: "Markdown", text: "Before." })).toBeDefined();
    expect(await ui.find({ type: "Markdown", text: "After." })).toBeDefined();
    expect(await ui.find({ type: "Markdown", text: "sequenceDiagram" })).toBeUndefined();
    const image = await ui.find({ type: "Image" });
    expect(image?.props).toMatchObject({
      source: { format: "png" },
      columns: 100,
      rows: 13,
      alt: "mermaid diagram (2 lines)",
    });
    expect(renders).toHaveLength(1);
    expect(renders[0]).toContain("-");
  });

  test("renders a diagram once across redraws", async ($, on) => {
    const { renders } = fakeHost(on);
    await (await mountReply($, REPLY)).unmount();
    await mountReply($, REPLY);

    expect(renders).toHaveLength(1);
  });

  test("keeps the source when merman-cli cannot parse the diagram", async ($, on) => {
    const { renders, files, toasts } = fakeHost(on, { isParseError: true });
    await (await mountReply($, REPLY)).unmount();
    const ui = await mountReply($, REPLY);

    expect(await ui.find({ type: "Image" })).toBeUndefined();
    expect(await ui.find({ type: "Markdown", text: "sequenceDiagram" })).toBeDefined();
    expect(renders).toHaveLength(1);
    expect([...files.keys()]).toEqual([]);
    expect(toasts).toEqual([
      "mermaid: merman-cli could not render a diagram: Parse error on line 2",
    ]);
  });

  test("retries a render that could not start", async ($, on) => {
    const { toasts } = fakeHost(on, { mermanRejects: 1 });
    await (await mountReply($, REPLY)).unmount();
    const ui = await mountReply($, REPLY);

    expect(await ui.find({ type: "Image" })).toBeDefined();
    expect(toasts).toEqual(["mermaid: $.process.run: merman-cli: command not found"]);
  });

  test("retries after the cache directory could not be made", async ($, on) => {
    fakeHost(on, { mkdirFails: 1 });
    await (await mountReply($, REPLY)).unmount();
    const ui = await mountReply($, REPLY);

    expect(await ui.find({ type: "Image" })).toBeDefined();
  });

  test("renders to a temporary file and renames it into the cache", async ($, on) => {
    const { renders, files } = fakeHost(on);
    const ui = await mountReply($, REPLY);

    const image = await ui.find({ type: "Image" });
    const cached = (image?.props as { source: { file: string } }).source.file;
    expect(cached).toMatch(IS_CACHED_PNG);
    const output = renders[0]?.[(renders[0]?.indexOf("-o") ?? 0) + 1];
    expect(output).not.toBe(cached);
    expect(output?.startsWith(`${CACHE}/`)).toBe(true);
    expect([...files.keys()]).toEqual([cached]);
  });

  test("renders again over a cached file that is not a whole PNG", async ($, on) => {
    const { renders } = fakeHost(on, { isCacheStale: true });
    const ui = await mountReply($, REPLY);

    expect(await ui.find({ type: "Image" })).toBeDefined();
    expect(renders).toHaveLength(1);
  });

  test("leaves a reply without a closed mermaid fence to the engine", async ($, on) => {
    const { renders } = fakeHost(on);
    for (const text of ["No diagrams here.", `\`\`\`mermaid\n${DIAGRAM}`]) {
      const ui = await mountReply($, text);
      expect(await ui.find({ type: "Text", text: "drawn by the engine" })).toBeDefined();
    }

    expect(renders).toHaveLength(0);
  });

  test("leaves other surfaces to the engine", async ($, on) => {
    const { renders } = fakeHost(on);
    const ui = await mountReply($, REPLY, "desktop");

    expect(await ui.find({ type: "Text", text: "drawn by the engine" })).toBeDefined();
    expect(renders).toHaveLength(0);
  });
});
