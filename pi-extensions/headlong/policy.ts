export type HeadlongBackoffConfig = {
  baseMs: number;
  factor: number;
  capMs: number;
  hold: number;
};

export type HeadlongBackoffState = {
  backoffLevel: number;
  ticksAtLevel: number;
  consecutiveFailures: number;
};

function assertBackoffConfig(config: HeadlongBackoffConfig): void {
  if (
    !Number.isFinite(config.baseMs) ||
    config.baseMs <= 0 ||
    !Number.isFinite(config.factor) ||
    config.factor < 1 ||
    !Number.isFinite(config.capMs) ||
    config.capMs < config.baseMs ||
    !Number.isSafeInteger(config.hold) ||
    config.hold < 1
  ) {
    throw new Error("Invalid Headlong backoff configuration");
  }
}

export function computeIdleDelayMs(level: number, config: HeadlongBackoffConfig): number {
  assertBackoffConfig(config);
  if (!Number.isSafeInteger(level) || level < 0) throw new Error("Invalid Headlong backoff level");
  if (level === 0) return 0;
  return Math.min(config.capMs, config.baseMs * config.factor ** (level - 1));
}

export function nextIdleBackoff(
  state: Pick<HeadlongBackoffState, "backoffLevel" | "ticksAtLevel">,
  config: HeadlongBackoffConfig,
): Pick<HeadlongBackoffState, "backoffLevel" | "ticksAtLevel"> {
  assertBackoffConfig(config);
  const nextTicks = state.ticksAtLevel + 1;
  if (nextTicks < config.hold) {
    return { backoffLevel: state.backoffLevel, ticksAtLevel: nextTicks };
  }
  const nextLevel = state.backoffLevel + 1;
  return {
    backoffLevel:
      computeIdleDelayMs(state.backoffLevel, config) === config.capMs
        ? state.backoffLevel
        : nextLevel,
    ticksAtLevel: 0,
  };
}

export function applyMeaningfulEvent<T extends HeadlongBackoffState>(state: T): T {
  return {
    ...state,
    backoffLevel: 0,
    ticksAtLevel: 0,
    consecutiveFailures: 0,
  };
}
