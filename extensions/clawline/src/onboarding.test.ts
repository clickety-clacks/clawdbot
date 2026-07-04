import { describe, expect, it, vi } from "vitest";
import { clawlineSetupAdapter } from "./onboarding.js";

const gatewayLifecycleMocks = vi.hoisted(() => ({
  restartGatewayServiceAfterChannelConfigWrite: vi.fn(async () => true),
}));

vi.mock("openclaw/plugin-sdk/gateway-lifecycle", () => gatewayLifecycleMocks);

describe("clawline setup adapter", () => {
  it("generates a fresh CLU secret on each add while preserving non-secret config", () => {
    const first = clawlineSetupAdapter.applyAccountConfig({
      cfg: {
        channels: {
          clawline: {
            enabled: false,
            port: 19999,
            network: {
              bindAddress: "127.0.0.2",
              allowedOrigins: ["https://app.example"],
            },
            media: {
              storagePath: "/tmp/clawline-media",
            },
            server: {
              cluSecret: "old-secret",
            },
          },
        },
      },
      accountId: "default",
      input: {},
    });
    const second = clawlineSetupAdapter.applyAccountConfig({
      cfg: first,
      accountId: "default",
      input: {},
    });

    expect(first.channels?.clawline?.enabled).toBe(true);
    expect(first.channels?.clawline?.port).toBe(19999);
    expect(first.channels?.clawline?.network).toEqual({
      bindAddress: "127.0.0.2",
      allowedOrigins: ["https://app.example"],
    });
    expect(first.channels?.clawline?.media?.storagePath).toBe("/tmp/clawline-media");
    expect(first.channels?.clawline?.server?.cluSecret).toEqual(expect.any(String));
    expect(first.channels?.clawline?.server?.cluSecret).not.toBe("old-secret");
    expect(second.channels?.clawline?.server?.cluSecret).toEqual(expect.any(String));
    expect(second.channels?.clawline?.server?.cluSecret).not.toBe(
      first.channels?.clawline?.server?.cluSecret,
    );
  });

  it("restarts the gateway after config write so the new CLU secret becomes live", async () => {
    await clawlineSetupAdapter.afterAccountConfigWritten?.({
      previousCfg: {},
      cfg: {},
      accountId: "default",
      input: {},
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      } as never,
    });

    expect(
      gatewayLifecycleMocks.restartGatewayServiceAfterChannelConfigWrite,
    ).toHaveBeenCalledTimes(1);
  });

  it("fails setup readiness when the gateway restart does not complete", async () => {
    gatewayLifecycleMocks.restartGatewayServiceAfterChannelConfigWrite.mockResolvedValueOnce(false);

    await expect(
      clawlineSetupAdapter.afterAccountConfigWritten?.({
        previousCfg: {},
        cfg: {},
        accountId: "default",
        input: {},
        runtime: {
          log: vi.fn(),
          error: vi.fn(),
          exit: vi.fn(),
        } as never,
      }),
    ).rejects.toThrow("Gateway restart did not complete after Clawline config write.");
  });
});
