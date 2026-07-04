import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { complete } from "@earendil-works/pi-ai/compat";
import autonameExtension, {
  buildAutonameTranscript,
  DEFAULT_AUTONAME_FALLBACK_MODEL,
  sanitizeSessionName,
} from "../pi-extensions/autoname.js";

vi.mock("@earendil-works/pi-ai/compat", () => ({
  complete: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  BorderedLoader: class {
    signal = new AbortController().signal;
    onAbort?: () => void;
  },
}));

type RegisteredCommand = {
  handler: (args: string, ctx: MockCommandContext) => Promise<void>;
};

type MockCommandContext = {
  cwd: string;
  hasUI?: boolean;
  waitForIdle: () => Promise<void>;
  sessionManager: {
    getBranch: () => unknown[];
  };
  modelRegistry: {
    find: (provider: string, modelId: string) => unknown;
    getApiKey?: (model: unknown) => Promise<string | undefined>;
    getApiKeyAndHeaders?: (
      model: unknown,
    ) => Promise<
      { ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }
    >;
  };
  ui: {
    notify: (message: string, type?: "info" | "warning" | "error") => void;
    custom?: <T>(factory: (...args: never[]) => unknown) => Promise<T>;
  };
  getSystemPrompt?: () => string;
  getSystemPromptOptions?: () => {
    contextFiles?: Array<{ path: string; content: string }>;
  };
};

function textResponse(text: string) {
  return {
    content: [{ type: "text", text }],
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function createMockPi(flags: Record<string, string | undefined> = {}) {
  let command: RegisteredCommand | undefined;
  let sessionName: string | undefined;

  return {
    pi: {
      registerFlag: vi.fn(),
      getFlag: vi.fn((name: string) => flags[name]),
      setSessionName: vi.fn((name: string) => {
        sessionName = name;
      }),
      registerCommand: vi.fn((_name: string, registered: RegisteredCommand) => {
        command = registered;
      }),
    },
    getCommand() {
      if (!command) {
        throw new Error("Command was not registered");
      }
      return command;
    },
    getSessionName() {
      return sessionName;
    },
  };
}

function createContext(overrides: Partial<MockCommandContext> = {}): MockCommandContext {
  const models = new Map([
    ["anthropic/claude-haiku-4-5", { provider: "anthropic", id: "claude-haiku-4-5" }],
    ["openai-codex/gpt-5.5", { provider: "openai-codex", id: "gpt-5.5" }],
  ]);

  return {
    cwd: "/tmp/example-project",
    waitForIdle: vi.fn(async () => undefined),
    sessionManager: {
      getBranch: vi.fn(() => [
        {
          type: "message",
          message: {
            role: "user",
            content: "Add automatic Pi session naming",
          },
        },
      ]),
    },
    modelRegistry: {
      find: vi.fn((provider: string, modelId: string) => models.get(`${provider}/${modelId}`)),
      getApiKey: vi.fn(async () => "test-key"),
    },
    ui: {
      notify: vi.fn(),
    },
    ...overrides,
  };
}

describe("autoname extension", () => {
  const originalModel = process.env.PI_AUTONAME_MODEL;
  const originalFallbackModel = process.env.PI_AUTONAME_FALLBACK_MODEL;
  const originalPromptFile = process.env.PI_AUTONAME_PROMPT_FILE;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(complete).mockReset();
    delete process.env.PI_AUTONAME_MODEL;
    delete process.env.PI_AUTONAME_FALLBACK_MODEL;
    delete process.env.PI_AUTONAME_PROMPT_FILE;
  });

  afterEach(() => {
    restoreEnv("PI_AUTONAME_MODEL", originalModel);
    restoreEnv("PI_AUTONAME_FALLBACK_MODEL", originalFallbackModel);
    restoreEnv("PI_AUTONAME_PROMPT_FILE", originalPromptFile);
  });

  it("registers the autoname command", () => {
    const { pi, getCommand } = createMockPi();

    autonameExtension(pi as never);

    expect(pi.registerCommand).toHaveBeenCalledWith("autoname", expect.any(Object));
    expect(getCommand()).toBeDefined();
  });

  it("builds a transcript with project, messages, summaries, and tool calls", () => {
    const transcript = buildAutonameTranscript(
      [
        { type: "message", message: { role: "user", content: "Fix the search tool" } },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "I will inspect the extension." },
              { type: "toolCall", name: "read", arguments: { path: "pi-extensions/webfetch.ts" } },
            ],
          },
        },
        { type: "compaction", summary: "Implemented most of the webfetch parser." },
      ],
      "/work/agent-customization",
    );

    expect(transcript).toContain("Project: agent-customization");
    expect(transcript).toContain("User: Fix the search tool");
    expect(transcript).toContain("Tool call: read");
    expect(transcript).toContain("Compaction summary");
  });

  it("sanitizes model output into a short session name", () => {
    const name = sanitizeSessionName('## Title: "Automatic Pi Session Naming Extension"\nextra');

    expect(name).toBe("Automatic Pi Session Naming Extension");
  });

  it("removes redundant session prefixes from model output", () => {
    const name = sanitizeSessionName("Session autoname extension implementation");

    expect(name).toBe("autoname extension implementation");
  });

  it("uses the fallback model when the primary model is unavailable", async () => {
    const [fallbackProvider, fallbackModelId] = DEFAULT_AUTONAME_FALLBACK_MODEL.split("/");
    vi.mocked(complete).mockResolvedValue(textResponse("Pi Autoname Command") as never);
    const { pi, getCommand, getSessionName } = createMockPi();
    const context = createContext({
      modelRegistry: {
        find: vi.fn((provider: string, modelId: string) => {
          if (provider === fallbackProvider && modelId === fallbackModelId) {
            return { provider, id: modelId };
          }
          return undefined;
        }),
        getApiKey: vi.fn(async () => "test-key"),
      },
    });

    autonameExtension(pi as never);
    await getCommand().handler("", context);

    expect(complete).toHaveBeenCalledTimes(1);
    expect(context.modelRegistry.find).toHaveBeenCalledWith(fallbackProvider, fallbackModelId);
    expect(getSessionName()).toBe("Pi Autoname Command");
  });

  it("sets the session name from the selected model response", async () => {
    vi.mocked(complete).mockResolvedValue(textResponse("Search API Refactor") as never);
    const { pi, getCommand, getSessionName } = createMockPi();
    const context = createContext();

    autonameExtension(pi as never);
    await getCommand().handler("", context);

    expect(getSessionName()).toBe("Search API Refactor");
    expect(context.ui.notify).toHaveBeenCalledWith("Session named: Search API Refactor", "info");
  });

  it("does not include Pi system prompt context in the naming request", async () => {
    vi.mocked(complete).mockResolvedValue(textResponse("Lightweight Naming Request") as never);
    const { pi, getCommand } = createMockPi();
    const context = createContext({
      getSystemPrompt: vi.fn(() => "system prompt with AGENTS.md content"),
      getSystemPromptOptions: vi.fn(() => ({
        contextFiles: [
          {
            path: "/tmp/example-project/AGENTS.md",
            content: "heavy project instructions",
          },
        ],
      })),
    });

    autonameExtension(pi as never);
    await getCommand().handler("", context);

    const request = vi.mocked(complete).mock.calls[0]?.[1] as unknown as Record<string, unknown>;
    const serializedRequest = JSON.stringify(request);

    expect(request).not.toHaveProperty("systemPrompt");
    expect(serializedRequest).not.toContain("AGENTS.md");
    expect(serializedRequest).not.toContain("heavy project instructions");
    expect(context.getSystemPrompt).not.toHaveBeenCalled();
    expect(context.getSystemPromptOptions).not.toHaveBeenCalled();
  });

  it("supports model registries that resolve API keys with headers", async () => {
    vi.mocked(complete).mockResolvedValue(textResponse("Runtime Auth Adapter") as never);
    const { pi, getCommand, getSessionName } = createMockPi();
    const context = createContext({
      modelRegistry: {
        find: vi.fn((provider: string, modelId: string) => ({ provider, id: modelId })),
        getApiKeyAndHeaders: vi.fn(async () => ({
          ok: true as const,
          apiKey: "header-key",
          headers: { "x-custom-auth": "token" },
        })),
      },
    });

    autonameExtension(pi as never);
    await getCommand().handler("", context);

    expect(getSessionName()).toBe("Runtime Auth Adapter");
    expect(complete).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ apiKey: "header-key", headers: { "x-custom-auth": "token" } }),
    );
  });

  it("shows an interactive loader while naming the session", async () => {
    vi.mocked(complete).mockResolvedValue(textResponse("Loader Visible Autoname") as never);
    const { pi, getCommand, getSessionName } = createMockPi();
    const customMock = vi.fn(async (factory: (...args: never[]) => unknown): Promise<unknown> => {
      return await new Promise((resolve) => {
        factory({} as never, {} as never, {} as never, resolve as never);
      });
    });
    const custom = customMock as NonNullable<MockCommandContext["ui"]["custom"]>;
    const context = createContext({
      hasUI: true,
      ui: {
        notify: vi.fn(),
        custom,
      },
    });

    autonameExtension(pi as never);
    await getCommand().handler("", context);

    expect(customMock).toHaveBeenCalledOnce();
    expect(getSessionName()).toBe("Loader Visible Autoname");
  });

  it("reports an error when no model can name the session", async () => {
    const { pi, getCommand } = createMockPi();
    const context = createContext({
      modelRegistry: {
        find: vi.fn(() => undefined),
        getApiKey: vi.fn(async () => undefined),
      },
    });

    autonameExtension(pi as never);
    await getCommand().handler("", context);

    expect(context.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Autoname failed"),
      "error",
    );
  });
});
