import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./run/attempt.js", () => ({
  runEmbeddedAttempt: vi.fn(),
}));

vi.mock("./model.js", () => ({
  resolveModel: vi.fn(() => ({
    model: {
      id: "test-model",
      provider: "openai",
      contextWindow: 200000,
      api: "openai-responses",
    },
    error: null,
    authStorage: {
      setRuntimeApiKey: vi.fn(),
    },
    modelRegistry: {},
  })),
}));

vi.mock("../model-auth.js", () => ({
  ensureAuthProfileStore: vi.fn(() => ({ profiles: {} })),
  getApiKeyForModel: vi.fn(async () => ({
    apiKey: "test-key",
    profileId: "test-profile",
    source: "test",
    mode: "api-key",
  })),
  resolveAuthProfileOrder: vi.fn(() => []),
}));

vi.mock("../models-config.js", () => ({
  ensureOpenClawModelsJson: vi.fn(async () => {}),
}));

vi.mock("../context-window-guard.js", () => ({
  CONTEXT_WINDOW_HARD_MIN_TOKENS: 1000,
  CONTEXT_WINDOW_WARN_BELOW_TOKENS: 5000,
  evaluateContextWindowGuard: vi.fn(() => ({
    shouldWarn: false,
    shouldBlock: false,
    tokens: 200000,
    source: "model",
  })),
  resolveContextWindowInfo: vi.fn(() => ({
    tokens: 200000,
    source: "model",
  })),
}));

vi.mock("../../utils/message-channel.js", () => ({
  isMarkdownCapableMessageChannel: vi.fn(() => true),
}));

vi.mock("../agent-paths.js", () => ({
  resolveOpenClawAgentDir: vi.fn(() => "/tmp/agent-dir"),
}));

vi.mock("../auth-profiles.js", () => ({
  isProfileInCooldown: vi.fn(() => false),
  markAuthProfileFailure: vi.fn(async () => {}),
  markAuthProfileGood: vi.fn(async () => {}),
  markAuthProfileUsed: vi.fn(async () => {}),
}));

vi.mock("../defaults.js", () => ({
  DEFAULT_CONTEXT_TOKENS: 200000,
  DEFAULT_MODEL: "test-model",
  DEFAULT_PROVIDER: "openai",
}));

vi.mock("../failover-error.js", () => ({
  FailoverError: class extends Error {},
  resolveFailoverStatus: vi.fn(),
}));

vi.mock("../usage.js", () => ({
  normalizeUsage: vi.fn((usage) => usage),
}));

vi.mock("./run/payloads.js", () => ({
  buildEmbeddedRunPayloads: vi.fn(() => []),
}));

vi.mock("./compact.js", () => ({
  compactEmbeddedPiSessionDirect: vi.fn(async () => ({
    ok: true,
    compacted: true,
    result: { summary: "ok", firstKeptEntryId: "entry-1", tokensBefore: 1000 },
  })),
}));

vi.mock("./logger.js", () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import type { EmbeddedRunAttemptResult, RunEmbeddedAttemptParams } from "./run/types.js";
import { clearCommandLane } from "../../process/command-queue.js";
import { runEmbeddedPiAgent } from "./run.js";
import { runEmbeddedAttempt } from "./run/attempt.js";

const mockedRunEmbeddedAttempt = vi.mocked(runEmbeddedAttempt);

function makeAttemptResult(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  return {
    aborted: false,
    timedOut: false,
    promptError: null,
    sessionIdUsed: "test-session",
    assistantTexts: ["ok"],
    toolMetas: [],
    lastAssistant: undefined,
    messagesSnapshot: [],
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const baseParams = {
  prompt: "hello",
  timeoutMs: 30_000,
  workspaceDir: "/tmp/openclaw-test-workspace",
  sessionFile: "/tmp/openclaw-test-session.jsonl",
  runId: "run-base",
  provider: "openai",
  model: "test-model",
};

describe("runEmbeddedPiAgent queue parallelism", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCommandLane("main");
  });

  it("runs different session keys in parallel", async () => {
    const sessionKeyA = "agent:main:clawline:flynn:main";
    const sessionKeyB = "agent:main:clawline:flynn:s_a90bdb7d";
    const laneA = `session:${sessionKeyA}`;
    const laneB = `session:${sessionKeyB}`;
    clearCommandLane(laneA);
    clearCommandLane(laneB);

    const gate = deferred<void>();
    const started: string[] = [];

    mockedRunEmbeddedAttempt.mockImplementation(async (params: RunEmbeddedAttemptParams) => {
      const key = params.sessionKey ?? "";
      started.push(key);
      if (key === sessionKeyA) {
        await gate.promise;
      }
      return makeAttemptResult({ sessionIdUsed: params.sessionId });
    });

    const runA = runEmbeddedPiAgent({
      ...baseParams,
      sessionId: "session-a",
      sessionKey: sessionKeyA,
      runId: "run-a",
      sessionFile: "/tmp/openclaw-test-session-a.jsonl",
    });
    await waitFor(() => started.includes(sessionKeyA));

    const runB = runEmbeddedPiAgent({
      ...baseParams,
      sessionId: "session-b",
      sessionKey: sessionKeyB,
      runId: "run-b",
      sessionFile: "/tmp/openclaw-test-session-b.jsonl",
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    const startedBeforeRelease = started.includes(sessionKeyB);
    gate.resolve();

    await Promise.all([runA, runB]);

    expect(startedBeforeRelease).toBe(true);
  });

  it("preserves ordering for the same session key", async () => {
    const sessionKey = "agent:main:clawline:flynn:main";
    const lane = `session:${sessionKey}`;
    clearCommandLane(lane);

    const gate = deferred<void>();
    let starts = 0;
    mockedRunEmbeddedAttempt.mockImplementation(async (params: RunEmbeddedAttemptParams) => {
      starts += 1;
      if (params.sessionId === "session-1") {
        await gate.promise;
      }
      return makeAttemptResult({ sessionIdUsed: params.sessionId });
    });

    const run1 = runEmbeddedPiAgent({
      ...baseParams,
      sessionId: "session-1",
      sessionKey,
      runId: "run-1",
      sessionFile: "/tmp/openclaw-test-same-session-1.jsonl",
    });
    await waitFor(() => starts === 1);

    const run2 = runEmbeddedPiAgent({
      ...baseParams,
      sessionId: "session-2",
      sessionKey,
      runId: "run-2",
      sessionFile: "/tmp/openclaw-test-same-session-2.jsonl",
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    const startsBeforeRelease = starts;
    gate.resolve();

    await Promise.all([run1, run2]);

    expect(startsBeforeRelease).toBe(1);
    expect(starts).toBe(2);
  });
});
