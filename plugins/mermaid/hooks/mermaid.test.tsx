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

/** Fakes merman-cli and the PNG cache beneath the plugin; returns the merman calls made. */
function fakeHost(on: On, { exitCode = 0 } = {}) {
  const renders: (readonly string[])[] = [];
  const written = new Set<string>();
  mock.env(on, { HOME: "/Users/test" });
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>drawn by the engine</Text>;
  });
  on("config.list", () => ({ value: [] }));
  on("process.run", (_$, e) => {
    if (e.argv[0] === "merman-cli") {
      renders.push(e.argv);
      const output = e.argv[e.argv.indexOf("-o") + 1];
      if (exitCode === 0 && output !== undefined) written.add(output);
    }
    const failed = e.argv[0] === "merman-cli" && exitCode !== 0;
    return {
      value: {
        exitCode: failed ? exitCode : 0,
        stdout: "",
        stderr: failed ? "Parse error on line 2" : "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });
  on("fs.exists", (_$, e) => ({ value: written.has(e.path) }));
  on("fs.read", () => ({ value: { base64: PNG_HEAD } }));
  return renders;
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
    const renders = fakeHost(on);
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
    const renders = fakeHost(on);
    await (await mountReply($, REPLY)).unmount();
    await mountReply($, REPLY);

    expect(renders).toHaveLength(1);
  });

  test("keeps the source when merman-cli fails", async ($, on) => {
    fakeHost(on, { exitCode: 2 });
    const ui = await mountReply($, REPLY);

    expect(await ui.find({ type: "Image" })).toBeUndefined();
    expect(await ui.find({ type: "Markdown", text: "sequenceDiagram" })).toBeDefined();
  });

  test("leaves a reply without a closed mermaid fence to the engine", async ($, on) => {
    const renders = fakeHost(on);
    for (const text of ["No diagrams here.", `\`\`\`mermaid\n${DIAGRAM}`]) {
      const ui = await mountReply($, text);
      expect(await ui.find({ type: "Text", text: "drawn by the engine" })).toBeDefined();
    }

    expect(renders).toHaveLength(0);
  });

  test("leaves other surfaces to the engine", async ($, on) => {
    const renders = fakeHost(on);
    const ui = await mountReply($, REPLY, "desktop");

    expect(await ui.find({ type: "Text", text: "drawn by the engine" })).toBeDefined();
    expect(renders).toHaveLength(0);
  });
});
