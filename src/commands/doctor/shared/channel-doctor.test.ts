import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectChannelDoctorCompatibilityMutations } from "./channel-doctor.js";

const mocks = vi.hoisted(() => ({
  getLoadedChannelPlugin: vi.fn(),
  getBundledChannelSetupPlugin: vi.fn(),
  listChannelPlugins: vi.fn(),
  listBundledChannelSetupPlugins: vi.fn(),
}));

vi.mock("../../../channels/plugins/registry.js", () => ({
  getLoadedChannelPlugin: (...args: Parameters<typeof mocks.getLoadedChannelPlugin>) =>
    mocks.getLoadedChannelPlugin(...args),
  listChannelPlugins: (...args: Parameters<typeof mocks.listChannelPlugins>) =>
    mocks.listChannelPlugins(...args),
}));

vi.mock("../../../channels/plugins/bundled.js", () => ({
  getBundledChannelSetupPlugin: (...args: Parameters<typeof mocks.getBundledChannelSetupPlugin>) =>
    mocks.getBundledChannelSetupPlugin(...args),
  listBundledChannelSetupPlugins: (
    ...args: Parameters<typeof mocks.listBundledChannelSetupPlugins>
  ) => mocks.listBundledChannelSetupPlugins(...args),
}));

describe("channel doctor compatibility mutations", () => {
  beforeEach(() => {
    mocks.getLoadedChannelPlugin.mockReset();
    mocks.getBundledChannelSetupPlugin.mockReset();
    mocks.listChannelPlugins.mockReset();
    mocks.listBundledChannelSetupPlugins.mockReset();
    mocks.getLoadedChannelPlugin.mockReturnValue(undefined);
    mocks.getBundledChannelSetupPlugin.mockReturnValue(undefined);
    mocks.listChannelPlugins.mockReturnValue([]);
    mocks.listBundledChannelSetupPlugins.mockReturnValue([]);
  });

  it("skips plugin discovery when no channels are configured", () => {
    const result = collectChannelDoctorCompatibilityMutations({} as never);

    expect(result).toEqual([]);
    expect(mocks.listChannelPlugins).not.toHaveBeenCalled();
    expect(mocks.listBundledChannelSetupPlugins).not.toHaveBeenCalled();
  });

  it("uses loaded doctor adapters for configured channel ids", () => {
    const normalizeCompatibilityConfig = vi.fn(({ cfg }: { cfg: unknown }) => ({
      config: cfg,
      changes: ["matrix"],
    }));
    mocks.getLoadedChannelPlugin.mockReturnValue({
      id: "matrix",
      doctor: { normalizeCompatibilityConfig },
    });

    const cfg = {
      channels: {
        matrix: {
          enabled: true,
        },
      },
    };

    const result = collectChannelDoctorCompatibilityMutations(cfg as never);

    expect(result).toHaveLength(1);
    expect(normalizeCompatibilityConfig).toHaveBeenCalledTimes(1);
    expect(mocks.getLoadedChannelPlugin).toHaveBeenCalledWith("matrix");
    expect(mocks.getBundledChannelSetupPlugin).not.toHaveBeenCalledWith("matrix");
    expect(mocks.getBundledChannelSetupPlugin).not.toHaveBeenCalledWith("discord");
    expect(mocks.listBundledChannelSetupPlugins).not.toHaveBeenCalled();
  });

  it("falls back when configured loaded channel plugin has no doctor adapter", () => {
    const normalizeCompatibilityConfig = vi.fn(({ cfg }: { cfg: unknown }) => ({
      config: cfg,
      changes: ["discord"],
    }));
    mocks.getBundledChannelSetupPlugin.mockImplementation((id: string) =>
      id === "discord"
        ? {
            id: "discord",
            doctor: { normalizeCompatibilityConfig },
          }
        : undefined,
    );

    const result = collectChannelDoctorCompatibilityMutations({
      channels: {
        discord: {
          enabled: true,
        },
      },
    } as never);

    expect(result).toHaveLength(1);
    expect(normalizeCompatibilityConfig).toHaveBeenCalledTimes(1);
    expect(mocks.getLoadedChannelPlugin).toHaveBeenCalledWith("discord");
    expect(mocks.getBundledChannelSetupPlugin).toHaveBeenCalledWith("discord");
  });

  it("keeps configured channel doctor lookup non-fatal when setup loading fails", () => {
    mocks.getBundledChannelSetupPlugin.mockImplementation((id: string) => {
      if (id === "discord") {
        throw new Error("missing runtime dep");
      }
      return undefined;
    });

    const result = collectChannelDoctorCompatibilityMutations({
      channels: {
        discord: {
          enabled: true,
        },
      },
    } as never);

    expect(result).toEqual([]);
    expect(mocks.getLoadedChannelPlugin).toHaveBeenCalledWith("discord");
    expect(mocks.getBundledChannelSetupPlugin).toHaveBeenCalledWith("discord");
  });
});
