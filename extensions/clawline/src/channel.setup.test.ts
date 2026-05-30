import { describe, expect, it, vi } from "vitest";
import { clawlineSetupPlugin } from "./channel.setup.js";

const gatewayLifecycleMocks = vi.hoisted(() => ({
  stopGatewayServiceBeforeChannelConfigDelete: vi.fn(async () => true),
}));

vi.mock("openclaw/plugin-sdk/gateway-lifecycle", () => gatewayLifecycleMocks);

describe("clawline channel setup plugin", () => {
  it("deletes the Clawline config section only through the destructive delete surface", () => {
    const next = clawlineSetupPlugin.config.deleteAccount?.({
      cfg: {
        channels: {
          clawline: {
            enabled: true,
            server: { cluSecret: "old-secret" },
          },
          telegram: {
            enabled: true,
          },
        },
      },
      accountId: "default",
    });

    expect(next?.channels?.clawline).toBeUndefined();
    expect(next?.channels?.telegram).toEqual({ enabled: true });
  });

  it("stops the gateway service before destructive delete can mutate config", async () => {
    await clawlineSetupPlugin.lifecycle?.beforeAccountRemoved?.({
      cfg: {},
      accountId: "default",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      } as never,
    });

    expect(gatewayLifecycleMocks.stopGatewayServiceBeforeChannelConfigDelete).toHaveBeenCalledTimes(
      1,
    );
  });

  it("fails closed when the gateway service cannot be confirmed stopped", async () => {
    gatewayLifecycleMocks.stopGatewayServiceBeforeChannelConfigDelete.mockResolvedValueOnce(false);

    await expect(
      clawlineSetupPlugin.lifecycle?.beforeAccountRemoved?.({
        cfg: {},
        accountId: "default",
        runtime: {
          log: vi.fn(),
          error: vi.fn(),
          exit: vi.fn(),
        } as never,
      }),
    ).rejects.toThrow("Gateway service did not stop before Clawline config deletion.");
  });
});
