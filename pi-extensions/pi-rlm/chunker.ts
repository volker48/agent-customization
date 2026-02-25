import type { DocType } from "./types.js";

const DEFAULT_CHUNK_SIZE = 1500;
const DEFAULT_OVERLAP = 200;

const CODE_PATTERNS: Record<string, RegExp> = {
  python: /^(?:def |class |async def )/m,
  typescript:
    /^(?:export (?:default )?)?(?:function |class |const \w+ = (?:async )?(?:\(|function))/m,
  javascript:
    /^(?:export (?:default )?)?(?:function |class |const \w+ = (?:async )?(?:\(|function))/m,
};

const MARKDOWN_PATTERN = /^#{1,6} /m;

interface ChunkOutput {
  text: string;
  charStart: number;
  charEnd: number;
}

interface ChunkOptions {
  type?: DocType;
  chunkSize?: number;
  overlap?: number;
}

export function detectDocType(content: string): DocType {
  if (CODE_PATTERNS.python.test(content)) return "python";
  if (CODE_PATTERNS.typescript.test(content)) return "typescript";
  if (MARKDOWN_PATTERN.test(content)) return "markdown";
  return "text";
}

function splitAtBoundaries(
  content: string,
  pattern: RegExp,
): string[] {
  const matches = [...content.matchAll(new RegExp(pattern, "gm"))];
  if (matches.length === 0) return [content];

  const sections: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end =
      i + 1 < matches.length ? matches[i + 1].index : content.length;
    if (i === 0 && start > 0) {
      sections.push(content.slice(0, start));
    }
    sections.push(content.slice(start, end));
  }
  return sections.filter((s) => s.length > 0);
}

function splitAtLines(text: string, maxSize: number): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxSize && current.length > 0) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function mergeSections(
  sections: string[],
  chunkSize: number,
): string[] {
  const merged: string[] = [];
  let current = "";

  for (const section of sections) {
    if (current.length === 0) {
      current = section;
      continue;
    }
    if (current.length + section.length <= chunkSize) {
      current += section;
    } else {
      merged.push(current);
      current = section;
    }
  }
  if (current.length > 0) merged.push(current);
  return merged;
}

function applyOverlap(
  texts: string[],
  overlap: number,
  content: string,
): ChunkOutput[] {
  if (texts.length === 0) return [];

  const results: ChunkOutput[] = [];
  let offset = 0;

  for (let i = 0; i < texts.length; i++) {
    const charStart = content.indexOf(texts[i], offset);
    const charEnd = charStart + texts[i].length;

    if (i === 0) {
      results.push({ text: texts[i], charStart, charEnd });
    } else {
      const overlapStart = Math.max(
        results[i - 1].charEnd - overlap,
        results[i - 1].charStart,
      );
      const overlapText = content.slice(overlapStart, results[i - 1].charEnd);
      const combined = overlapText + texts[i];
      results.push({
        text: combined,
        charStart: overlapStart,
        charEnd: charEnd,
      });
    }
    offset = charStart + 1;
  }
  return results;
}

function chunkCode(
  content: string,
  type: DocType,
  chunkSize: number,
  overlap: number,
): ChunkOutput[] {
  const pattern = CODE_PATTERNS[type];
  if (!pattern) return chunkProse(content, chunkSize, overlap);

  let sections = splitAtBoundaries(content, pattern);

  const expanded: string[] = [];
  for (const section of sections) {
    if (section.length > chunkSize) {
      expanded.push(...splitAtLines(section, chunkSize));
    } else {
      expanded.push(section);
    }
  }
  sections = expanded;

  const merged = mergeSections(sections, chunkSize);
  return applyOverlap(merged, overlap, content);
}

function chunkProse(
  content: string,
  chunkSize: number,
  overlap: number,
): ChunkOutput[] {
  const paragraphs = content.split(/\n\n+/);

  const expanded: string[] = [];
  for (const para of paragraphs) {
    if (para.length > chunkSize) {
      expanded.push(...splitAtLines(para, chunkSize));
    } else {
      expanded.push(para);
    }
  }

  const merged = mergeSections(expanded, chunkSize);
  return applyOverlap(merged, overlap, content);
}

function chunkMarkdown(
  content: string,
  chunkSize: number,
  overlap: number,
): ChunkOutput[] {
  let sections = splitAtBoundaries(content, MARKDOWN_PATTERN);

  const expanded: string[] = [];
  for (const section of sections) {
    if (section.length > chunkSize) {
      expanded.push(...splitAtLines(section, chunkSize));
    } else {
      expanded.push(section);
    }
  }
  sections = expanded;

  const merged = mergeSections(sections, chunkSize);
  return applyOverlap(merged, overlap, content);
}

export function chunkDocument(
  content: string,
  options: ChunkOptions = {},
): ChunkOutput[] {
  const type = options.type ?? detectDocType(content);
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = options.overlap ?? DEFAULT_OVERLAP;

  if (content.length === 0) return [];

  if (content.length <= chunkSize) {
    return [{ text: content, charStart: 0, charEnd: content.length }];
  }

  switch (type) {
    case "python":
    case "typescript":
    case "javascript":
      return chunkCode(content, type, chunkSize, overlap);
    case "markdown":
      return chunkMarkdown(content, chunkSize, overlap);
    case "text":
      return chunkProse(content, chunkSize, overlap);
  }
}
