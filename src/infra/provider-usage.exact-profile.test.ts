import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  ensureAuthProfileStoreWithoutExternalProfiles: vi.fn(),
  hasAnyAuthProfileStoreSource: vi.fn(),
  resolveApiKeyForProfile: vi.fn(),
  resolveAgentDir: vi.fn(() => "/state/agents/main/agent"),
  resolveProviderNativeUsageAuthWithPlugin: vi.fn(),
  isProviderUsageAuthProfileCompatibleWithPlugin: vi.fn(),
  resolveProviderSyntheticAuthWithPlugin: vi.fn(),
  resolveProviderUsageSnapshotWithPlugin: vi.fn(),
}));

vi.mock("../agents/agent-scope-config.js", () => ({
  resolveAgentDir: mocks.resolveAgentDir,
}));
vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles:
    mocks.ensureAuthProfileStoreWithoutExternalProfiles,
  hasAnyAuthProfileStoreSource: mocks.hasAnyAuthProfileStoreSource,
  resolveApiKeyForProfile: mocks.resolveApiKeyForProfile,
}));
vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../plugins/provider-runtime.js", () => ({
  isProviderUsageAuthProfileCompatibleWithPlugin:
    mocks.isProviderUsageAuthProfileCompatibleWithPlugin,
  resolveProviderNativeUsageAuthWithPlugin: mocks.resolveProviderNativeUsageAuthWithPlugin,
  resolveProviderSyntheticAuthWithPlugin: mocks.resolveProviderSyntheticAuthWithPlugin,
  resolveProviderUsageSnapshotWithPlugin: mocks.resolveProviderUsageSnapshotWithPlugin,
}));
vi.mock("./net/proxy-fetch.js", () => ({ resolveProxyFetchFromEnv: () => undefined }));

import {
  ProviderUsageBindingError,
  prepareProviderUsageBinding,
} from "./provider-usage.exact-profile.js";

describe("prepareProviderUsageBinding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasAnyAuthProfileStoreSource.mockReturnValue(false);
    mocks.ensureAuthProfileStore.mockReturnValue({ profiles: {} });
    mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({ profiles: {} });
    mocks.resolveProviderSyntheticAuthWithPlugin.mockReturnValue({
      apiKey: "synthetic-marker",
      source: "test",
      mode: "token",
    });
    mocks.isProviderUsageAuthProfileCompatibleWithPlugin.mockReturnValue(true);
  });

  it("binds the provider hook to the exact OAuth profile", async () => {
    mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
      profiles: {
        "openai:work": { type: "oauth", provider: "openai", access: "secret" },
        "openai:other": { type: "oauth", provider: "openai", access: "other-secret" },
      },
    });
    mocks.resolveApiKeyForProfile.mockResolvedValue({
      apiKey: "resolved-secret",
      profileId: "openai:work",
      profileType: "oauth",
    });
    const snapshot = {
      provider: "openai" as const,
      displayName: "OpenAI",
      windows: [{ label: "5h", usedPercent: 36 }],
    };
    mocks.resolveProviderUsageSnapshotWithPlugin.mockResolvedValue(snapshot);

    const prepared = prepareProviderUsageBinding({
      provider: "codex",
      authProfileId: " openai:work ",
      agentId: "main",
      config: {},
      timeoutMs: 5_000,
      env: {},
    });

    expect(prepared?.authKind).toBe("oauth");
    expect(prepared?.bindingKey).not.toContain("openai:work");
    await expect(prepared?.fetchSnapshot()).resolves.toEqual({
      bindingKey: prepared?.bindingKey,
      snapshot,
    });
    expect(mocks.resolveApiKeyForProfile).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "openai:work", allowLegacyProfileFallback: false }),
    );
    expect(mocks.resolveProviderUsageSnapshotWithPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          authProfileId: "openai:work",
          token: "synthetic-marker",
          timeoutMs: 5_000,
        }),
      }),
    );
  });

  it("returns no prepared read for a missing exact profile", () => {
    mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
      profiles: { "openai:other": { type: "oauth", provider: "openai" } },
    });

    expect(
      prepareProviderUsageBinding({
        provider: "codex",
        authProfileId: "openai:missing",
        agentId: "main",
        config: {},
        timeoutMs: 5_000,
      }),
    ).toBeNull();
    expect(mocks.resolveProviderUsageSnapshotWithPlugin).not.toHaveBeenCalled();
    expect(mocks.ensureAuthProfileStore).not.toHaveBeenCalled();
  });

  it("allows only the canonical external Codex profile to bootstrap", () => {
    mocks.ensureAuthProfileStore.mockReturnValue({
      profiles: {
        "openai:default": { type: "oauth", provider: "openai", access: "external" },
      },
    });

    expect(
      prepareProviderUsageBinding({
        provider: "codex",
        authProfileId: "openai:default",
        agentId: "main",
        config: {},
        timeoutMs: 5_000,
      }),
    ).toMatchObject({ authKind: "oauth" });
  });

  it("rejects a pinned profile that the provider cannot serve", () => {
    mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
      profiles: {
        "anthropic:work": { type: "oauth", provider: "anthropic", access: "secret" },
      },
    });
    mocks.isProviderUsageAuthProfileCompatibleWithPlugin.mockReturnValue(false);

    expect(
      prepareProviderUsageBinding({
        provider: "codex",
        authProfileId: "anthropic:work",
        agentId: "main",
        config: {},
        timeoutMs: 5_000,
      }),
    ).toBeNull();
    expect(mocks.isProviderUsageAuthProfileCompatibleWithPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ authKind: "oauth", authProvider: "anthropic" }),
      }),
    );
    expect(mocks.resolveProviderUsageSnapshotWithPlugin).not.toHaveBeenCalled();
  });

  it.each([
    ["api_key", "api-key"],
    ["token", "token"],
  ] as const)("reports %s profile auth truthfully without launching a read", (type, authKind) => {
    mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
      profiles: { "openai:work": { type, provider: "openai", key: "secret" } },
    });

    const prepared = prepareProviderUsageBinding({
      provider: "codex",
      authProfileId: "openai:work",
      agentId: "main",
      config: {},
      timeoutMs: 5_000,
    });

    expect(prepared?.authKind).toBe(authKind);
    expect(mocks.resolveProviderUsageSnapshotWithPlugin).not.toHaveBeenCalled();
  });

  it("binds native OAuth with null, discards a raced read, and retries once", async () => {
    mocks.resolveProviderNativeUsageAuthWithPlugin
      .mockReturnValueOnce({ authKind: "oauth", revision: "revision-a" })
      .mockReturnValueOnce({ authKind: "oauth", revision: "revision-a" })
      .mockReturnValueOnce({ authKind: "oauth", revision: "revision-b" })
      .mockReturnValueOnce({ authKind: "oauth", revision: "revision-b" })
      .mockReturnValueOnce({ authKind: "oauth", revision: "revision-b" });
    mocks.resolveProviderUsageSnapshotWithPlugin.mockResolvedValue({
      provider: "openai",
      displayName: "OpenAI",
      windows: [],
    });
    const prepared = prepareProviderUsageBinding({
      provider: "codex",
      authProfileId: null,
      agentId: "main",
      config: {},
      timeoutMs: 5_000,
      env: {},
    });

    expect(prepared?.authKind).toBe("oauth");
    const result = await prepared?.fetchSnapshot();
    expect(result?.bindingKey).not.toBe(prepared?.bindingKey);
    expect(mocks.resolveProviderUsageSnapshotWithPlugin).toHaveBeenCalledTimes(2);
    expect(mocks.resolveProviderUsageSnapshotWithPlugin).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ context: expect.objectContaining({ authProfileId: null }) }),
    );
  });

  it("returns unavailable after a second native auth race", async () => {
    mocks.resolveProviderNativeUsageAuthWithPlugin
      .mockReturnValueOnce({ authKind: "oauth", revision: "revision-a" })
      .mockReturnValueOnce({ authKind: "oauth", revision: "revision-a" })
      .mockReturnValueOnce({ authKind: "oauth", revision: "revision-b" })
      .mockReturnValueOnce({ authKind: "oauth", revision: "revision-b" })
      .mockReturnValueOnce({ authKind: "oauth", revision: "revision-c" });
    mocks.resolveProviderUsageSnapshotWithPlugin.mockResolvedValue({
      provider: "openai",
      displayName: "OpenAI",
      windows: [],
    });
    const prepared = prepareProviderUsageBinding({
      provider: "codex",
      authProfileId: null,
      agentId: "main",
      config: {},
      timeoutMs: 5_000,
      env: {},
    });

    await expect(prepared?.fetchSnapshot()).rejects.toEqual(
      expect.objectContaining<Partial<ProviderUsageBindingError>>({
        code: "account_binding_unavailable",
      }),
    );
    expect(mocks.resolveProviderUsageSnapshotWithPlugin).toHaveBeenCalledTimes(2);
  });

  it("does not consume the post-read retry when revision changes before the query", async () => {
    mocks.resolveProviderNativeUsageAuthWithPlugin
      .mockReturnValueOnce({ authKind: "oauth", revision: "revision-a" })
      .mockReturnValueOnce({ authKind: "oauth", revision: "revision-b" })
      .mockReturnValueOnce({ authKind: "oauth", revision: "revision-c" })
      .mockReturnValueOnce({ authKind: "oauth", revision: "revision-c" })
      .mockReturnValueOnce({ authKind: "oauth", revision: "revision-c" });
    mocks.resolveProviderUsageSnapshotWithPlugin.mockResolvedValue({
      provider: "openai",
      displayName: "OpenAI",
      windows: [],
    });
    const prepared = prepareProviderUsageBinding({
      provider: "codex",
      authProfileId: null,
      agentId: "main",
      config: {},
      timeoutMs: 5_000,
      env: {},
    });

    await expect(prepared?.fetchSnapshot()).resolves.toEqual({
      bindingKey: expect.any(String),
      snapshot: expect.any(Object),
    });
    expect(mocks.resolveProviderUsageSnapshotWithPlugin).toHaveBeenCalledTimes(2);
  });

  it("refuses native binding when a configured auth-store source exists", () => {
    mocks.hasAnyAuthProfileStoreSource.mockReturnValue(true);

    expect(
      prepareProviderUsageBinding({
        provider: "codex",
        authProfileId: null,
        agentId: "main",
        config: {},
        timeoutMs: 5_000,
      }),
    ).toBeNull();
    expect(mocks.resolveProviderNativeUsageAuthWithPlugin).not.toHaveBeenCalled();
  });

  it("refuses native binding when Codex external default auth is available", () => {
    mocks.ensureAuthProfileStore.mockReturnValue({
      profiles: {
        "openai:default": { type: "oauth", provider: "openai", access: "external" },
      },
    });

    expect(
      prepareProviderUsageBinding({
        provider: "codex",
        authProfileId: null,
        agentId: "main",
        config: {},
        timeoutMs: 5_000,
      }),
    ).toBeNull();
    expect(mocks.resolveProviderNativeUsageAuthWithPlugin).not.toHaveBeenCalled();
  });

  it("sanitizes exact-profile resolution failures", async () => {
    mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
      profiles: { "openai:work": { type: "oauth", provider: "openai" } },
    });
    mocks.resolveApiKeyForProfile.mockRejectedValue(new Error("secret refresh token leaked"));
    const prepared = prepareProviderUsageBinding({
      provider: "codex",
      authProfileId: "openai:work",
      agentId: "main",
      config: {},
      timeoutMs: 5_000,
    });

    await expect(prepared?.fetchSnapshot()).rejects.toEqual(
      expect.objectContaining<Partial<ProviderUsageBindingError>>({
        code: "account_binding_unavailable",
        message: "auth binding unavailable",
      }),
    );
  });

  it("bounds exact-profile auth refresh inside the provider timeout", async () => {
    mocks.ensureAuthProfileStoreWithoutExternalProfiles.mockReturnValue({
      profiles: { "openai:work": { type: "oauth", provider: "openai" } },
    });
    mocks.resolveApiKeyForProfile.mockReturnValue(new Promise(() => undefined));
    const prepared = prepareProviderUsageBinding({
      provider: "codex",
      authProfileId: "openai:work",
      agentId: "main",
      config: {},
      timeoutMs: 1,
    });

    await expect(prepared?.fetchSnapshot()).rejects.toEqual(
      expect.objectContaining<Partial<ProviderUsageBindingError>>({ code: "timeout" }),
    );
  });
});
