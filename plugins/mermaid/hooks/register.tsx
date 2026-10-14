import type { EngineInterface, Register } from "claude-code";

/** Terminal cells are about twice as tall as they are wide. */
const CELL_ASPECT = 0.5;
/** Rendered pixels per terminal column at merman's scale 2, so small diagrams stay small. */
const PIXELS_PER_COLUMN = 16;
const MAX_CELLS = 255;
const RENDER_TIMEOUT_MS = 10_000;

export type Segment =
  | { kind: "markdown"; text: string }
  | { kind: "mermaid"; source: string; raw: string };

type Diagram = { path: string; width: number; height: number };

/**
 * Splits markdown into prose and closed mermaid fences.
 *
 * A fence that is still open (the reply is streaming) stays prose, as does a
 * mermaid fence nested inside another code block.
 */
export function splitMermaid(text: string): Segment[] {
  const segments: Segment[] = [];
  let prose: string[] = [];
  let fence: { char: string; length: number; isMermaid: boolean; lines: string[] } | undefined;

  const flushProse = () => {
    const joined = prose.join("\n");
    if (joined.trim() !== "") segments.push({ kind: "markdown", text: joined });
    prose = [];
  };

  for (const line of text.split("\n")) {
    if (fence === undefined) {
      const open = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
      if (open === null) {
        prose.push(line);
        continue;
      }
      const marker = open[1] ?? "";
      fence = {
        char: marker[0] ?? "`",
        length: marker.length,
        isMermaid: open[2]?.toLowerCase() === "mermaid",
        lines: [line],
      };
      continue;
    }

    fence.lines.push(line);
    const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)?.[1];
    if (close === undefined || close[0] !== fence.char || close.length < fence.length) continue;

    if (fence.isMermaid) {
      flushProse();
      segments.push({
        kind: "mermaid",
        source: fence.lines.slice(1, -1).join("\n"),
        raw: fence.lines.join("\n"),
      });
    } else {
      prose.push(...fence.lines);
    }
    fence = undefined;
  }

  if (fence !== undefined) prose.push(...fence.lines);
  flushProse();
  return segments;
}

/** Reads width and height from a PNG's IHDR chunk (bytes 16 to 24, big-endian). */
export function pngSize(base64: string): { width: number; height: number } {
  const head = atob(base64.slice(0, 32));
  if (head.slice(1, 4) !== "PNG" || head.length < 24) throw new Error("not a PNG");
  const u32 = (at: number) =>
    ((head.charCodeAt(at) << 24) |
      (head.charCodeAt(at + 1) << 16) |
      (head.charCodeAt(at + 2) << 8) |
      head.charCodeAt(at + 3)) >>>
    0;
  return { width: u32(16), height: u32(20) };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function mermaidTheme($: EngineInterface): Promise<string> {
  const theme = (await $.config.list()).find((row) => row.key === "theme")?.value;
  return typeof theme === "string" && theme.includes("light") ? "default" : "dark";
}

// Shared by every redraw of a diagram (streaming, scroll, resize) for this load;
// the PNG cache on disk carries renders across reloads and sessions.
const renders = new Map<string, Promise<Diagram | undefined>>();
let cacheDir: Promise<string> | undefined;

async function makeCacheDir($: EngineInterface): Promise<string> {
  const home = await $.env.get("HOME");
  if (home === undefined) throw new Error("HOME is not set");
  const dir = `${home}/.cache/claude-mermaid`;
  const made = await $.process.run(["mkdir", "-p", dir]);
  if (made.exitCode !== 0) throw new Error(`mkdir ${dir}: ${made.stderr.trim()}`);
  return dir;
}

/** Renders `source` to a cached PNG, or toasts why not and answers undefined. */
async function renderPng($: EngineInterface, args: string[], source: string, hash: string) {
  try {
    cacheDir ??= makeCacheDir($);
    const path = `${await cacheDir}/${hash}.png`;
    if (!(await $.fs.exists(path))) {
      const ran = await $.process.run(["merman-cli", ...args, "-o", path, "-"], {
        stdin: source,
        timeoutMs: RENDER_TIMEOUT_MS,
      });
      if (ran.exitCode !== 0) {
        const reason = ran.stderr.trim().split("\n")[0] || `exit ${ran.exitCode}`;
        $.ui.toast(`mermaid: merman-cli could not render a diagram: ${reason}`);
        return undefined;
      }
    }
    const png = await $.fs.read(path, { as: "bytes" });
    return { path, ...pngSize(png.base64) };
  } catch (error) {
    $.ui.toast(`mermaid: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function render($: EngineInterface, source: string, theme: string) {
  const args = ["render", "-q", "-f", "png", "-t", theme, "-b", "transparent", "-s", "2"];
  const hash = await sha256(JSON.stringify([args, source]));
  let pending = renders.get(hash);
  if (pending === undefined) {
    pending = renderPng($, args, source, hash);
    renders.set(hash, pending);
  }
  return pending;
}

export const register: Register = (on) => {
  on("ui.render", { component: "AssistantMessage" }, async ($, e, next) => {
    if (e.surface !== "terminal" || e.props.isSummary) return next(e);
    const segments = splitMermaid(e.props.text);
    if (!segments.some((segment) => segment.kind === "mermaid")) return next(e);

    const theme = await mermaidTheme($);
    const diagrams = await Promise.all(
      segments.map((segment) =>
        segment.kind === "mermaid" ? render($, segment.source, theme) : undefined,
      ),
    );
    const available = Math.max(1, (e.viewport?.columns ?? 80) - 4);
    const { Box, Image, Markdown } = $.ui.resolve(e);

    return (
      <Box flexDirection="column">
        {segments.map((segment, i) => {
          if (segment.kind === "markdown") return <Markdown text={segment.text} />;
          const diagram = diagrams[i];
          if (diagram === undefined) return <Markdown text={segment.raw} />;
          const columns = Math.min(
            available,
            MAX_CELLS,
            Math.ceil(diagram.width / PIXELS_PER_COLUMN),
          );
          const rows = Math.round((columns * diagram.height * CELL_ASPECT) / diagram.width);
          return (
            <Image
              source={{ file: diagram.path, format: "png" }}
              columns={columns}
              rows={Math.min(MAX_CELLS, Math.max(1, rows))}
              alt={`mermaid diagram (${segment.source.split("\n").length} lines)`}
            />
          );
        })}
      </Box>
    );
  });
};
