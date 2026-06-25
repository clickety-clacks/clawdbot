/**
 * Runtime plugin config regression tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  applyPluginAutoEnable: vi.fn(),
  getCurrentPluginMetadataSnapshot: vi.fn(),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: mocks.getCurrentPluginMetadataSnapshot,
}));

describe("resolveGatewayPluginConfig", () => {
  beforeEach(() => {
    mocks.applyPluginAutoEnable.mockReset();
    mocks.getCurrentPluginMetadataSnapshot.mockReset();
  });

  it("delegates same-snapshot freshness to plugin auto-enable", async () => {
    const { resolveGatewayPluginConfig } = await import("./runtime-plugin-config.js");
    const config = { channels: { telegram: { botToken: "token" } } } as OpenClawConfig;
    const snapshot = { manifestRegistry: { plugins: [], diagnostics: [] } };
    const resolved = { ...config, plugins: { allow: ["telegram"] } } as OpenClawConfig;
    mocks.getCurrentPluginMetadataSnapshot.mockReturnValue(snapshot);
    mocks.applyPluginAutoEnable.mockReturnValue({ config: resolved, changes: [] });

    expect(resolveGatewayPluginConfig({ config })).toBe(resolved);
    expect(resolveGatewayPluginConfig({ config })).toBe(resolved);

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledTimes(2);
    expect(mocks.applyPluginAutoEnable).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        config,
        manifestRegistry: snapshot.manifestRegistry,
      }),
    );
  });

  it("uses the current metadata snapshot on every resolution", async () => {
    const { resolveGatewayPluginConfig } = await import("./runtime-plugin-config.js");
    const config = { channels: { telegram: { botToken: "token" } } } as OpenClawConfig;
    const first = { manifestRegistry: { plugins: [], diagnostics: [] } };
    const second = { manifestRegistry: { plugins: [], diagnostics: [] } };
    mocks.getCurrentPluginMetadataSnapshot.mockReturnValueOnce(first).mockReturnValue(second);
    mocks.applyPluginAutoEnable
      .mockReturnValueOnce({ config: { ...config, first: true }, changes: [] })
      .mockReturnValueOnce({ config: { ...config, second: true }, changes: [] });

    expect(resolveGatewayPluginConfig({ config })).toMatchObject({ first: true });
    expect(resolveGatewayPluginConfig({ config })).toMatchObject({ second: true });

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledTimes(2);
  });

  it("does not reuse stale output after the same env object changes", async () => {
    const { resolveGatewayPluginConfig } = await import("./runtime-plugin-config.js");
    const config = {} as OpenClawConfig;
    const env = { OPENCLAW_TEST_AUTO_ENABLE: "one" } as NodeJS.ProcessEnv;
    const snapshot = { manifestRegistry: { plugins: [], diagnostics: [] } };
    mocks.getCurrentPluginMetadataSnapshot.mockReturnValue(snapshot);
    mocks.applyPluginAutoEnable
      .mockReturnValueOnce({ config: { value: "one" }, changes: [] })
      .mockReturnValueOnce({ config: { value: "two" }, changes: [] });

    expect(resolveGatewayPluginConfig({ config, env })).toMatchObject({ value: "one" });
    env.OPENCLAW_TEST_AUTO_ENABLE = "two";
    expect(resolveGatewayPluginConfig({ config, env })).toMatchObject({ value: "two" });

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledTimes(2);
    expect(mocks.applyPluginAutoEnable).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ config, env }),
    );
  });

  it("does not cache without a current metadata snapshot", async () => {
    const { resolveGatewayPluginConfig } = await import("./runtime-plugin-config.js");
    const config = {} as OpenClawConfig;
    mocks.getCurrentPluginMetadataSnapshot.mockReturnValue(undefined);
    mocks.applyPluginAutoEnable.mockImplementation(() => ({ config: {}, changes: [] }));

    resolveGatewayPluginConfig({ config });
    resolveGatewayPluginConfig({ config });

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledTimes(2);
  });
});
