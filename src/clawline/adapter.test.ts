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

const { runCliAgent } = await import("../agents/cli-runner.js");

describe("createClawlineAdapter", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawline-test-"));
    vi.mocked(runCliAgent).mockReset();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function buildConfig(): ClawdbotConfig {
    return {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-5" },
          cliBackends: {
            anthropic: {
              command: "claude",
            },
          },
          workspace: path.join(tmpDir, "workspace"),
          timeoutSeconds: 30,
        },
      },
    } as ClawdbotConfig;
  }

  it("throws when no primary model configured", async () => {
    await expect(
      createClawlineAdapter({
        config: { agents: { defaults: {} } } as unknown as ClawdbotConfig,
        statePath: tmpDir,
      }),
    ).rejects.toThrow(/agents.defaults.model/i);
  });

  it("calls runCliAgent with derived session data", async () => {
    vi.mocked(runCliAgent).mockResolvedValue({
      payloads: [{ text: "Hello from agent" }],
      meta: { durationMs: 10 },
    });

    const adapter = await createClawlineAdapter({
      config: buildConfig(),
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
    expect(call?.provider).toBe("anthropic");
    expect(call?.model).toBe("claude-sonnet-4-5");
    expect(result).toEqual({ exitCode: 0, output: "Hello from agent" });
  });

  it("returns non-zero exit when payload text missing", async () => {
    vi.mocked(runCliAgent).mockResolvedValue({
      payloads: [],
      meta: { durationMs: 5 },
    });
    const adapter = await createClawlineAdapter({
      config: buildConfig(),
      statePath: tmpDir,
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
  });
});
