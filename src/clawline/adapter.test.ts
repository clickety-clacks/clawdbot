import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClawdbotConfig } from "../config/config.js";
import { createClawlineAdapter } from "./adapter.js";
import { resolveClawlineConfig } from "./config.js";

vi.mock("../agents/cli-runner.js", () => ({
  runCliAgent: vi.fn(),
}));
vi.mock("../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: vi.fn(),
}));
vi.mock("../agents/agent-paths.js", () => ({
  resolveClawdbotAgentDir: vi.fn(() => "/tmp/agent-dir"),
}));

const { runCliAgent } = await import("../agents/cli-runner.js");
const { runEmbeddedPiAgent } = await import("../agents/pi-embedded.js");

describe("createClawlineAdapter", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawline-test-"));
    vi.mocked(runCliAgent).mockReset();
    vi.mocked(runEmbeddedPiAgent).mockReset();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function buildConfig(): ClawdbotConfig {
    return {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-5" },
          workspace: path.join(tmpDir, "workspace"),
          timeoutSeconds: 30,
        },
      },
    } as ClawdbotConfig;
  }

  function buildCliConfig(): ClawdbotConfig {
    const cfg = buildConfig();
    (cfg.agents!.defaults as any).cliBackends = {
      anthropic: { command: "claude" },
    };
    return cfg;
  }

  it("throws when no primary model configured", async () => {
    await expect(
      createClawlineAdapter({
        config: { agents: { defaults: {} } } as unknown as ClawdbotConfig,
        statePath: tmpDir,
      }),
    ).rejects.toThrow(/agents.defaults.model/i);
  });

  it("calls runCliAgent when provider uses CLI backend", async () => {
    vi.mocked(runCliAgent).mockResolvedValue({
      payloads: [{ text: "Hello from agent" }],
      meta: { durationMs: 10 },
    });

    const adapter = await createClawlineAdapter({
      config: buildCliConfig(),
      statePath: tmpDir,
    });

    const result = await adapter.execute({
      prompt: "Hi there",
      userId: "user_123",
      sessionId: "sess_123",
      deviceId: "device_a",
    });

    expect(runCliAgent).toHaveBeenCalledTimes(1);
    const call = vi.mocked(runCliAgent).mock.calls[0]?.[0];
    expect(call?.prompt).toBe("Hi there");
    expect(call?.sessionId).toBe("sess_123");
    expect(call?.sessionKey).toContain("clawline");
    expect(call?.sessionKey).toContain("user");
    expect(call?.provider).toBe("anthropic");
    expect(call?.model).toBe("claude-sonnet-4-5");
    expect(result).toEqual({ exitCode: 0, output: "Hello from agent" });
  });

  it("uses embedded agent when provider is not CLI", async () => {
    vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
      payloads: [{ text: "Embedded hello" }],
      meta: { durationMs: 8 },
    });

    const adapter = await createClawlineAdapter({
      config: buildConfig(),
      statePath: tmpDir,
    });

    const result = await adapter.execute({
      prompt: "Ping",
      userId: "user_embedded",
      sessionId: "sess_embedded",
      deviceId: "device_embedded",
    });

    expect(runCliAgent).not.toHaveBeenCalled();
    expect(runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
    expect(call?.sessionKey).toContain("clawline:user_embedded");
    expect(call?.messageProvider).toBe("clawline");
    expect(call?.agentAccountId).toBe("user_embedded");
    expect(call?.agentDir).toBe("/tmp/agent-dir");
    expect(call?.verboseLevel).toBe("off");
    expect(call?.reasoningLevel).toBe("off");
    expect(call?.bashElevated).toEqual({
      enabled: false,
      allowed: false,
      defaultLevel: "off",
    });
    expect(call?.enforceFinalTag).toBe(false);
    expect(typeof call?.onAgentEvent).toBe("function");
    expect(result).toEqual({ exitCode: 0, output: "Embedded hello" });
  });

  it("returns non-zero exit when payload text missing", async () => {
    vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
      payloads: [],
      meta: { durationMs: 5 },
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const adapter = await createClawlineAdapter({
      config: buildConfig(),
      statePath: tmpDir,
      logger,
      clawlineConfig: resolveClawlineConfig({
        clawline: { adapter: { responseFallback: "No reply" } },
      } as ClawdbotConfig),
    });
    const result = await adapter.execute({
      prompt: "Hi",
      userId: "user_x",
      sessionId: "sess_x",
      deviceId: "device_x",
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toBe("No reply");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("falls back to context overflow message when embedded run errors", async () => {
    vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
      payloads: [
        { text: "Context length exceeded for this model.", isError: true },
      ],
      meta: { durationMs: 12 },
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const adapter = await createClawlineAdapter({
      config: buildConfig(),
      statePath: tmpDir,
      logger,
    });
    const result = await adapter.execute({
      prompt: "Overflow?",
      userId: "user_ctx",
      sessionId: "sess_ctx",
      deviceId: "device_ctx",
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/Context overflow/i);
    expect(logger.warn).toHaveBeenCalledWith(
      "[clawline] agent run hit context overflow",
    );
  });

  it("logs warning when no text and no fallback configured", async () => {
    vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
      payloads: [],
      meta: { durationMs: 5 },
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const adapter = await createClawlineAdapter({
      config: buildConfig(),
      statePath: tmpDir,
      logger,
    });
    await adapter.execute({
      prompt: "Hi",
      userId: "user_warn",
      sessionId: "sess_warn",
      deviceId: "device_warn",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "[clawline] adapter returned no text; consider setting clawline.adapter.responseFallback",
    );
  });

  it("persists CLI session ids across adapter instances", async () => {
    vi.mocked(runCliAgent).mockResolvedValue({
      payloads: [{ text: "cli hello" }],
      meta: {
        durationMs: 2,
        agentMeta: { sessionId: "cli-session-1", provider: "anthropic", model: "test" },
      },
    });

    const adapter = await createClawlineAdapter({
      config: buildCliConfig(),
      statePath: tmpDir,
    });

    await adapter.execute({
      prompt: "store me",
      userId: "user_cli",
      sessionId: "sess_cli",
      deviceId: "device_cli",
    });

    const storePath = path.join(tmpDir, "cli-sessions.json");
    const stored = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
      string,
      string
    >;
    expect(stored["clawline:user_cli:device_cli"]).toBe("cli-session-1");

    vi.mocked(runCliAgent).mockReset();
    vi.mocked(runCliAgent).mockResolvedValue({
      payloads: [{ text: "cli hello 2" }],
      meta: { durationMs: 1 },
    });

    const adapterReloaded = await createClawlineAdapter({
      config: buildCliConfig(),
      statePath: tmpDir,
    });

    await adapterReloaded.execute({
      prompt: "reuse session",
      userId: "user_cli",
      sessionId: "sess_cli2",
      deviceId: "device_cli",
    });

    const call = vi.mocked(runCliAgent).mock.calls[0]?.[0];
    expect(call?.cliSessionId).toBe("cli-session-1");
  });
});
