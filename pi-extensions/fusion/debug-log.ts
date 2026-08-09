import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { FusionConfig, FusionProgressEvent, FusionResult } from "./types.js";

export interface FusionDebugLogger {
  readonly path: string;
  log(event: string, details?: { [key: string]: unknown }): void;
  flush(): Promise<void>;
}

export function resolveFusionDebugLogPath(config: FusionConfig): string | undefined {
  if (config.debugLogPath?.trim()) return config.debugLogPath.trim();
  if (process.env.PI_FUSION_LOG?.trim()) return process.env.PI_FUSION_LOG.trim();
  if (process.env.PI_FUSION_DEBUG === "1") {
    return join(homedir(), ".pi", "agent", "fusion-debug.jsonl");
  }
  return undefined;
}

export function createFusionDebugLogger(
  path: string,
  runId: string = crypto.randomUUID(),
): FusionDebugLogger {
  let sequence = 0;
  let queue = Promise.resolve();

  const logger: FusionDebugLogger = {
    path,
    log(event, details = {}) {
      const entry = {
        timestamp: new Date().toISOString(),
        runId,
        sequence: sequence++,
        event,
        ...details,
      };
      queue = queue
        .then(async () => {
          await mkdir(dirname(path), { recursive: true });
          await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
        })
        .catch(() => undefined);
    },
    async flush() {
      await queue;
    },
  };

  return logger;
}

export function progressLogDetails(event: FusionProgressEvent): { [key: string]: unknown } {
  return event;
}

export function resultLogDetails(result: FusionResult): { [key: string]: unknown } {
  return {
    status: result.status,
    judge: result.judge,
    elapsedMs: result.elapsedMs,
    responseCount: result.responses.length,
    successCount: result.responses.filter((response) => response.status === "ok").length,
    error: result.error,
    confidence: result.confidence,
    capsuleRevision: result.capsule
      ? `${result.capsule.capsuleId}@${result.capsule.revision}`
      : undefined,
  };
}
