// Onboard channel post-write tests cover plugin post-write hooks after channel setup.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  createChannelOnboardingPostWriteHook,
  createChannelOnboardingPostWriteHookCollector,
  runCollectedChannelOnboardingPostWriteHooks,
} from "./onboard-channels.js";
import { createExitThrowingRuntime } from "./test-wizard-helpers.js";

describe("setupChannels post-write hooks", () => {
  it("collects onboarding post-write hooks and runs them against the final config", async () => {
    const afterConfigWritten = vi.fn(async () => {});
    const previousCfg = {} as OpenClawConfig;
    const cfg = {
      channels: {
        telegram: { botToken: "new-token" },
      },
    } as OpenClawConfig;
    const adapter = {
      afterConfigWritten,
    };
    const collector = createChannelOnboardingPostWriteHookCollector();
    const runtime = createExitThrowingRuntime();
    const hook = createChannelOnboardingPostWriteHook({
      accountId: "acct-1",
      adapter,
      channel: "telegram",
      previousCfg,
    });

    if (!hook) {
      throw new Error("expected post-write hook");
    }
    collector.collect(hook);

    expect(afterConfigWritten).not.toHaveBeenCalled();

    await runCollectedChannelOnboardingPostWriteHooks({
      hooks: collector.drain(),
      cfg,
      runtime,
    });

    expect(afterConfigWritten).toHaveBeenCalledWith({
      previousCfg,
      cfg,
      accountId: "acct-1",
      runtime,
    });
  });

  it("logs onboarding post-write hook failures without aborting", async () => {
    const runtime = createExitThrowingRuntime();

    await runCollectedChannelOnboardingPostWriteHooks({
      hooks: [
        {
          channel: "telegram",
          accountId: "acct-1",
          run: async () => {
            throw new Error("hook failed");
          },
        },
      ],
      cfg: {} as OpenClawConfig,
      runtime,
    });

    expect(runtime.error).toHaveBeenCalledWith(
      'Channel telegram post-setup warning for "acct-1": hook failed',
    );
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("fails required onboarding post-write hook failures", async () => {
    const runtime = createExitThrowingRuntime();

    await expect(
      runCollectedChannelOnboardingPostWriteHooks({
        hooks: [
          {
            channel: "clawline",
            accountId: "default",
            required: true,
            run: async () => {
              throw new Error("restart failed");
            },
          },
        ],
        cfg: {} as OpenClawConfig,
        runtime,
      }),
    ).rejects.toThrow("exit:1");

    expect(runtime.error).toHaveBeenCalledWith(
      'Channel clawline post-setup failed for "default": restart failed',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("returns false for required hook failures when runtime exit does not throw", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const succeeded = await runCollectedChannelOnboardingPostWriteHooks({
      hooks: [
        {
          channel: "clawline",
          accountId: "default",
          required: true,
          run: async () => {
            throw new Error("restart failed");
          },
        },
      ],
      cfg: {} as OpenClawConfig,
      runtime,
    });

    expect(succeeded).toBe(false);
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
