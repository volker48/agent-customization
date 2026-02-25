import { describe, expect, it } from "vitest";
import { chunkDocument, detectDocType } from "./chunker.js";
import { DocumentStore } from "./store.js";

const PYTHON_CODE = `import os

def hello(name):
    print(f"Hello, {name}!")

def goodbye(name):
    print(f"Goodbye, {name}!")

class Greeter:
    def __init__(self, name):
        self.name = name

    def greet(self):
        return f"Hello, {self.name}!"
`;

const TS_CODE = `export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}

export class Calculator {
  private result = 0;

  add(n: number): this {
    this.result += n;
    return this;
  }

  getValue(): number {
    return this.result;
  }
}
`;

const MARKDOWN_DOC = `# Introduction

This is the first paragraph of the introduction.
It explains the purpose of the document.

## Getting Started

Follow these steps to get started with the project.
You will need Node.js installed.

## Configuration

Configuration is done through environment variables.
See the table below for available options.
`;

const PROSE_DOC = `This is the first paragraph of a plain text document.
It contains several sentences about various topics.

This is the second paragraph. It discusses different matters
and provides additional context for the reader.

This is the third paragraph with more content that helps
to test the chunking behavior with prose documents.
`;

describe("chunker", () => {
  describe("type detection", () => {
    it("detects Python code", () => {
      expect(detectDocType(PYTHON_CODE)).toBe("python");
    });

    it("detects TypeScript code", () => {
      expect(detectDocType(TS_CODE)).toBe("typescript");
    });

    it("detects Markdown", () => {
      expect(detectDocType(MARKDOWN_DOC)).toBe("markdown");
    });

    it("falls back to text", () => {
      expect(detectDocType(PROSE_DOC)).toBe("text");
    });
  });

  describe("prose splitting", () => {
    it("splits at paragraph boundaries", () => {
      const chunks = chunkDocument(PROSE_DOC, {
        type: "text",
        chunkSize: 150,
        overlap: 0,
      });
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeGreaterThan(0);
      }
    });
  });

  describe("code splitting", () => {
    it("splits Python at function/class definitions", () => {
      const chunks = chunkDocument(PYTHON_CODE, {
        type: "python",
        chunkSize: 100,
        overlap: 0,
      });
      expect(chunks.length).toBeGreaterThan(1);
    });

    it("splits TypeScript at function/class/export definitions", () => {
      const chunks = chunkDocument(TS_CODE, {
        type: "typescript",
        chunkSize: 100,
        overlap: 0,
      });
      expect(chunks.length).toBeGreaterThan(1);
    });
  });

  describe("charStart/charEnd offsets", () => {
    it("has correct offsets for each chunk", () => {
      const content = PYTHON_CODE;
      const chunks = chunkDocument(content, {
        type: "python",
        chunkSize: 100,
        overlap: 0,
      });
      for (const chunk of chunks) {
        expect(chunk.charStart).toBeGreaterThanOrEqual(0);
        expect(chunk.charEnd).toBeGreaterThan(chunk.charStart);
        expect(chunk.charEnd).toBeLessThanOrEqual(content.length);
      }
    });
  });

  describe("oversized single function", () => {
    it("splits at line boundaries when a function exceeds chunk size", () => {
      const bigFunction = [
        "def big_function():",
        ...Array.from({ length: 50 }, (_, i) => `    line_${i} = ${i}`),
        "",
      ].join("\n");

      const chunks = chunkDocument(bigFunction, {
        type: "python",
        chunkSize: 200,
        overlap: 0,
      });
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.text).not.toBe("");
      }
    });
  });

  describe("overlap", () => {
    it("produces overlapping content between adjacent chunks", () => {
      const chunks = chunkDocument(PYTHON_CODE, {
        type: "python",
        chunkSize: 100,
        overlap: 30,
      });
      if (chunks.length >= 2) {
        const first = chunks[0];
        const second = chunks[1];
        expect(second.charStart).toBeLessThan(first.charEnd);
      }
    });
  });

  describe("edge cases", () => {
    it("returns empty array for empty content", () => {
      expect(chunkDocument("")).toEqual([]);
    });

    it("returns single chunk for small content", () => {
      const chunks = chunkDocument("Hello world");
      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe("Hello world");
      expect(chunks[0].charStart).toBe(0);
      expect(chunks[0].charEnd).toBe(11);
    });
  });
});

describe("DocumentStore", () => {
  describe("addDocument", () => {
    it("creates chunks with stable hash IDs", () => {
      const store = new DocumentStore();
      const doc1 = store.addDocument(PYTHON_CODE);
      const doc2 = store.addDocument(PYTHON_CODE);
      expect(doc1.id).toBe(doc2.id);
      expect(doc1.chunkIds).toEqual(doc2.chunkIds);
    });

    it("deduplicates same content", () => {
      const store = new DocumentStore();
      const doc1 = store.addDocument(PYTHON_CODE, { name: "test.py" });
      const doc2 = store.addDocument(PYTHON_CODE, { name: "test.py" });
      expect(doc1).toBe(doc2);
    });

    it("stores document with correct metadata", () => {
      const store = new DocumentStore();
      const doc = store.addDocument(PYTHON_CODE, {
        name: "test.py",
        type: "python",
      });
      expect(doc.name).toBe("test.py");
      expect(doc.totalChars).toBe(PYTHON_CODE.length);
      expect(doc.chunkIds.length).toBeGreaterThan(0);
    });
  });

  describe("search", () => {
    it("returns results with scores", () => {
      const store = new DocumentStore();
      store.addDocument(PYTHON_CODE, {
        name: "test.py",
        type: "python",
      });

      const results = store.search("hello");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].score).toBeGreaterThan(0);
      expect(results[0].chunkId).toBeDefined();
      expect(results[0].text).toContain("hello");
    });

    it("respects limit option", () => {
      const store = new DocumentStore();
      store.addDocument(PYTHON_CODE, {
        name: "test.py",
        type: "python",
      });

      const results = store.search("name", { limit: 1 });
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it("returns empty array for no matches", () => {
      const store = new DocumentStore();
      store.addDocument(PYTHON_CODE, {
        name: "test.py",
        type: "python",
      });

      const results = store.search("xyznonexistent");
      expect(results).toEqual([]);
    });
  });

  describe("extractByChunkId", () => {
    it("returns correct chunk", () => {
      const store = new DocumentStore();
      const doc = store.addDocument(PYTHON_CODE, {
        name: "test.py",
        type: "python",
      });

      const chunk = store.extractByChunkId(doc.chunkIds[0]);
      expect(chunk).not.toBeNull();
      expect(chunk!.docId).toBe(doc.id);
      expect(chunk!.text.length).toBeGreaterThan(0);
    });

    it("returns null for invalid ID", () => {
      const store = new DocumentStore();
      expect(store.extractByChunkId("nonexistent")).toBeNull();
    });
  });

  describe("extractByRange", () => {
    it("returns correct character span", () => {
      const store = new DocumentStore();
      const doc = store.addDocument(PYTHON_CODE, {
        name: "test.py",
        type: "python",
      });

      const span = store.extractByRange(doc.id, 0, 20);
      expect(span).not.toBeNull();
      expect(span).toBe(PYTHON_CODE.slice(0, 20));
    });

    it("returns null for unknown docId", () => {
      const store = new DocumentStore();
      expect(store.extractByRange("unknown", 0, 10)).toBeNull();
    });
  });

  describe("buffers", () => {
    it("round-trips values via save/get", () => {
      const store = new DocumentStore();
      const data = { key: "value", count: 42 };
      store.saveBuffer("test-buffer", data);

      const retrieved = store.getBuffer("test-buffer");
      expect(retrieved).toEqual(data);
    });

    it("returns undefined for missing buffer", () => {
      const store = new DocumentStore();
      expect(store.getBuffer("missing")).toBeUndefined();
    });
  });

  describe("snapshot/restore", () => {
    it("round-trips entire store state", () => {
      const store = new DocumentStore();
      store.addDocument(PYTHON_CODE, {
        name: "test.py",
        type: "python",
      });
      store.saveBuffer("notes", { summary: "test" });

      const snap = store.snapshot();

      const store2 = new DocumentStore();
      store2.restore(snap);

      const results = store2.search("hello");
      expect(results.length).toBeGreaterThan(0);

      const buffer = store2.getBuffer("notes");
      expect(buffer).toEqual({ summary: "test" });
    });

    it("search works after restore", () => {
      const store = new DocumentStore();
      store.addDocument(MARKDOWN_DOC, {
        name: "readme.md",
        type: "markdown",
      });

      const snap = store.snapshot();
      const restored = new DocumentStore();
      restored.restore(snap);

      const original = store.search("configuration");
      const afterRestore = restored.search("configuration");
      expect(afterRestore.length).toBe(original.length);
      if (original.length > 0) {
        expect(afterRestore[0].chunkId).toBe(original[0].chunkId);
      }
    });
  });

  describe("addDocumentBatch", () => {
    it("adds multiple documents", () => {
      const store = new DocumentStore();
      const docs = store.addDocumentBatch([
        {
          content: PYTHON_CODE,
          options: { name: "test.py", type: "python" },
        },
        {
          content: MARKDOWN_DOC,
          options: { name: "readme.md", type: "markdown" },
        },
      ]);
      expect(docs).toHaveLength(2);
    });

    it("is idempotent for duplicate content", () => {
      const store = new DocumentStore();
      const docs = store.addDocumentBatch([
        { content: PYTHON_CODE, options: { name: "a.py" } },
        { content: PYTHON_CODE, options: { name: "b.py" } },
      ]);
      expect(docs[0].id).toBe(docs[1].id);
    });
  });

  describe("reset", () => {
    it("clears all state", () => {
      const store = new DocumentStore();
      store.addDocument(PYTHON_CODE, { name: "test.py" });
      store.saveBuffer("buf", "data");

      store.reset();

      expect(store.search("hello")).toEqual([]);
      expect(store.getBuffer("buf")).toBeUndefined();
    });
  });
});
