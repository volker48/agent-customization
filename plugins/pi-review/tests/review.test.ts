import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defaults, object, parseConfig, runPi, type Json } from "../scripts/review.ts";
const bin = fileURLToPath(new URL("./fake-pi.mjs", import.meta.url));
const run = (id: string, extra = {}) =>
  runPi({
    cwd: tmpdir(),
    model: { provider: "opencode", id, thinking: "medium" },
    prompt: "Review this",
    timeoutSeconds: 2,
    bin,
    ...extra,
  });
test("config retains exact defaults and supports custom provider IDs with slashes", () => {
  assert.deepEqual(parseConfig({}), defaults);
  assert.deepEqual(
    parseConfig({ models: [{ provider: "openrouter", id: "vendor/model", thinking: "high" }] })
      .models[0],
    { provider: "openrouter", id: "vendor/model", thinking: "high" },
  );
});
test("config rejects malformed values and unknown fields", () => {
  const invalid: Json[] = [
    { models: [] },
    { models: [{ id: "" }] },
    { models: [{ id: "x", thinking: "ultra" }] },
    { timeoutSeconds: -1 },
    { timeoutSeconds: 1.5 },
    { model: "typo" },
  ];
  for (const input of invalid) assert.throws(() => parseConfig(input));
});
test("RPC discovers models without prompting", async () =>
  assert.ok(Array.isArray(await run("ok", { list: true }))));
test("RPC preserves unicode separators and waits for retry settlement", async () => {
  for (const id of ["ok", "retry"])
    assert.equal(object(await run(id)).text, "Review\u2028finding\u2029preserved");
});
test("RPC rejects unavailable exact models, provider errors, invalid JSON and empty output", async () => {
  await assert.rejects(run("unknown"), /Model unavailable/);
  await assert.rejects(run("error"), /provider unavailable/);
  await assert.rejects(run("malformed"), /JSON/);
  await assert.rejects(run("empty"), /no review text/);
});
test("RPC timeout and caller cancellation terminate the child", async () => {
  await assert.rejects(run("hang", { timeoutSeconds: 0.1 }), /timed out/);
  const controller = new AbortController();
  const result = run("hang", { signal: controller.signal });
  controller.abort();
  await assert.rejects(result, /cancelled/);
});
test("CLI preserves successful results on partial failure and refuses output overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-test-"));
  try {
    const script = fileURLToPath(new URL("../scripts/review.ts", import.meta.url));
    const brief = fileURLToPath(new URL("../README.md", import.meta.url));
    const output = join(root, "results");
    const args = [
      script,
      "--prompt-file",
      brief,
      "--output",
      output,
      "--model",
      "opencode/ok",
      "--model",
      "opencode/error",
    ];
    const exec = promisify(execFile);
    await assert.rejects(
      exec(process.execPath, args, {
        env: { ...process.env, PI_REVIEW_BIN: bin, PI_REVIEW_CONFIG: undefined },
      }),
    );
    const result = object(JSON.parse(await readFile(join(output, "results.json"), "utf8")) as Json);
    assert.ok(Array.isArray(result.results));
    assert.deepEqual(
      result.results.map((value) => object(value).status),
      ["ok", "error"],
    );
    await assert.rejects(
      exec(process.execPath, args, { env: { ...process.env, PI_REVIEW_BIN: bin } }),
      /EEXIST/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("RPC accepts empty blocks alongside review text and rejects truncated reviews", async () => {
  assert.equal(object(await run("mixed")).text, "\nReview\u2028finding\u2029preserved");
  await assert.rejects(run("length"), /length/);
});
