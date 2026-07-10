import { createHash } from "node:crypto";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  hasAnyAuthProfileStoreSource,
  resolveApiKeyForProfile,
} from "../agents/auth-profiles.js";
import { OPENAI_CODEX_DEFAULT_PROFILE_ID } from "../agents/auth-profiles/constants.js";
import { getRuntimeConfig, type OpenClawConfig } from "../config/config.js";
import {
  isProviderUsageAuthProfileCompatibleWithPlugin,
  resolveProviderNativeUsageAuthWithPlugin,
  resolveProviderSyntheticAuthWithPlugin,
  resolveProviderUsageSnapshotWithPlugin,
} from "../plugins/provider-runtime.js";
import type { ProviderUsageAuthKind } from "../plugins/types.js";
import { resolveFetch } from "./fetch.js";
import { resolveProxyFetchFromEnv } from "./net/proxy-fetch.js";
import type { ProviderUsageSnapshot } from "./provider-usage.types.js";

export type ProviderUsageFetchResult = {
  bindingKey: string;
  snapshot: ProviderUsageSnapshot | null;
};

export type PreparedProviderUsageBinding = {
  authKind: ProviderUsageAuthKind;
  bindingKey: string;
  fetchSnapshot: () => Promise<ProviderUsageFetchResult>;
  isCurrent?: () => boolean;
};

export class ProviderUsageBindingError extends Error {
  constructor(
    public readonly code: "account_binding_unavailable" | "timeout",
    public readonly unsettledWork?: Promise<void>,
    public readonly bindingKey?: string,
  ) {
    super(code === "timeout" ? "provider usage request timed out" : "auth binding unavailable");
    this.name = "ProviderUsageBindingError";
  }
}

/** Prepare one exact profile/native usage binding without consulting profile order. */
export function prepareProviderUsageBinding(params: {
  provider: string;
  authProfileId: string | null;
  agentId: string;
  config?: OpenClawConfig;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): PreparedProviderUsageBinding | null {
  const config = params.config ?? getRuntimeConfig();
  const env = params.env ?? process.env;
  const agentDir = resolveAgentDir(config, params.agentId, env);
  if (params.authProfileId === undefined) {
    return null;
  }
  if (params.authProfileId !== null) {
    return prepareProfileBinding({
      provider: params.provider,
      authProfileId: params.authProfileId,
      config,
      timeoutMs: params.timeoutMs,
      env,
      agentDir,
    });
  }
  return prepareNativeBinding({ ...params, config, env, agentDir });
}

function prepareProfileBinding(params: {
  provider: string;
  authProfileId: string;
  config: OpenClawConfig;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  agentDir: string;
}): PreparedProviderUsageBinding | null {
  const authProfileId = params.authProfileId.trim();
  if (!authProfileId) {
    return null;
  }
  const localStore = ensureAuthProfileStoreWithoutExternalProfiles(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const store =
    localStore.profiles[authProfileId] || authProfileId !== OPENAI_CODEX_DEFAULT_PROFILE_ID
      ? localStore
      : ensureAuthProfileStore(params.agentDir, {
          allowKeychainPrompt: false,
          config: params.config,
          externalCliProfileIds: [OPENAI_CODEX_DEFAULT_PROFILE_ID],
        });
  const credential = store.profiles[authProfileId];
  if (!credential) {
    return null;
  }
  const authKind = normalizeProfileAuthKind(credential.type);
  if (
    !isProviderUsageAuthProfileCompatibleWithPlugin({
      provider: params.provider,
      config: params.config,
      env: params.env,
      context: {
        provider: params.provider,
        config: params.config,
        authKind,
        authProvider: credential.provider,
      },
    })
  ) {
    return null;
  }
  const bindingKey = opaqueBindingKey("profile", params.provider, params.agentDir, authProfileId);
  return {
    authKind,
    bindingKey,
    fetchSnapshot: () =>
      withBindingTimeout(
        (async () => {
          let resolved: Awaited<ReturnType<typeof resolveApiKeyForProfile>>;
          try {
            resolved = await resolveApiKeyForProfile({
              cfg: params.config,
              store,
              profileId: authProfileId,
              agentDir: params.agentDir,
              allowLegacyProfileFallback: false,
            });
          } catch {
            throw new ProviderUsageBindingError("account_binding_unavailable");
          }
          if (!resolved || resolved.profileId !== authProfileId) {
            throw new ProviderUsageBindingError("account_binding_unavailable");
          }
          const snapshot = await fetchBoundUsageSnapshot({
            ...params,
            authProfileId,
            token: resolveSyntheticToken(params) ?? resolved.apiKey,
          });
          return { bindingKey, snapshot };
        })(),
        params.timeoutMs,
      ),
  };
}

function prepareNativeBinding(params: {
  provider: string;
  config: OpenClawConfig;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  agentDir: string;
}): PreparedProviderUsageBinding | null {
  if (hasAnyAuthProfileStoreSource(params.agentDir)) {
    return null;
  }
  const store = ensureAuthProfileStoreWithoutExternalProfiles(params.agentDir, {
    allowKeychainPrompt: false,
  });
  if (Object.keys(store.profiles).length > 0) {
    return null;
  }
  const externalDefaultStore = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
    config: params.config,
    externalCliProfileIds: [OPENAI_CODEX_DEFAULT_PROFILE_ID],
  });
  if (externalDefaultStore.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID]) {
    return null;
  }
  const resolved = resolveNativeUsageAuth(params);
  if (!resolved) {
    return null;
  }
  const bindingKey = nativeBindingKey(params, resolved.revision);
  const isCurrent = () => {
    const current = resolveNativeUsageAuth(params);
    return current?.authKind === resolved.authKind && current.revision === resolved.revision;
  };
  return {
    authKind: resolved.authKind,
    bindingKey,
    isCurrent,
    fetchSnapshot: () => withBindingTimeout(fetchNativeUsageSnapshot(params, 1), params.timeoutMs),
  };
}

async function fetchNativeUsageSnapshot(
  params: {
    provider: string;
    config: OpenClawConfig;
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    agentDir: string;
  },
  retriesRemaining: number,
): Promise<ProviderUsageFetchResult> {
  const before = resolveNativeUsageAuth(params);
  if (!before || before.authKind !== "oauth") {
    throw new ProviderUsageBindingError("account_binding_unavailable");
  }
  const snapshot = await fetchBoundUsageSnapshot({
    ...params,
    authProfileId: null,
    token: resolveSyntheticToken(params) ?? "",
  });
  const after = resolveNativeUsageAuth(params);
  if (after?.authKind === "oauth" && after.revision === before.revision) {
    return { bindingKey: nativeBindingKey(params, before.revision), snapshot };
  }
  if (retriesRemaining > 0 && after?.authKind === "oauth") {
    return await fetchNativeUsageSnapshot(params, retriesRemaining - 1);
  }
  throw new ProviderUsageBindingError(
    "account_binding_unavailable",
    undefined,
    after ? nativeBindingKey(params, after.revision) : undefined,
  );
}

function nativeBindingKey(
  params: { provider: string; agentDir: string },
  revision: string,
): string {
  return opaqueBindingKey("native", params.provider, params.agentDir, revision);
}

function resolveNativeUsageAuth(params: {
  provider: string;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  agentDir: string;
}) {
  return resolveProviderNativeUsageAuthWithPlugin({
    provider: params.provider,
    config: params.config,
    env: params.env,
    context: {
      provider: params.provider,
      config: params.config,
      env: params.env,
      agentDir: params.agentDir,
    },
  });
}

function resolveSyntheticToken(params: {
  provider: string;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): string | undefined {
  return resolveProviderSyntheticAuthWithPlugin({
    provider: params.provider,
    config: params.config,
    env: params.env,
    context: { config: params.config, provider: params.provider },
  })?.apiKey;
}

async function fetchBoundUsageSnapshot(params: {
  provider: string;
  config: OpenClawConfig;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  agentDir: string;
  authProfileId: string | null;
  token: string;
}): Promise<ProviderUsageSnapshot | null> {
  const fetchFn = resolveProxyFetchFromEnv(params.env) ?? resolveFetch();
  if (!fetchFn) {
    return null;
  }
  const work = resolveProviderUsageSnapshotWithPlugin({
    provider: params.provider,
    config: params.config,
    env: params.env,
    context: {
      config: params.config,
      agentDir: params.agentDir,
      env: params.env,
      provider: params.provider,
      token: params.token,
      authProfileId: params.authProfileId,
      timeoutMs: params.timeoutMs,
      fetchFn,
    },
  });
  return (await work) ?? null;
}

function normalizeProfileAuthKind(
  kind: "oauth" | "token" | "api_key",
): Exclude<ProviderUsageAuthKind, "unknown"> {
  return kind === "api_key" ? "api-key" : kind;
}

function opaqueBindingKey(kind: string, ...parts: string[]): string {
  const hash = createHash("sha256");
  hash.update("openclaw:provider-usage-binding:v1");
  hash.update("\0");
  hash.update(kind);
  for (const part of parts) {
    hash.update("\0");
    hash.update(part);
  }
  return hash.digest("hex");
}

async function withBindingTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => {
            const unsettledWork = work.then(
              () => undefined,
              () => undefined,
            );
            reject(new ProviderUsageBindingError("timeout", unsettledWork));
          },
          Math.max(1, timeoutMs),
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
