import os from "node:os";
import path from "node:path";

import type { ClawdbotConfig } from "../config/config.js";
import type { ProviderConfig } from "./server.js";

export type ClawlineAdapterOverrides = {
  provider?: string;
  model?: string;
  timeoutSeconds?: number;
  responseFallback?: string;
  systemPrompt?: string;
};

export type ResolvedClawlineConfig = ProviderConfig & {
  enabled: boolean;
  adapterOverrides: ClawlineAdapterOverrides;
};

type ProviderConfigBase = Omit<ProviderConfig, "adapter">;

export type ClawlineConfigInput = {
  enabled?: boolean;
  adapter?: ClawlineAdapterOverrides;
} & Partial<ProviderConfigBase>;

const defaultStatePath = path.join(os.homedir(), ".clawdbot", "clawline");
const defaultMediaPath = path.join(os.homedir(), ".clawdbot", "clawline-media");

const DEFAULTS: ResolvedClawlineConfig = {
  enabled: true,
  port: 18792,
  statePath: defaultStatePath,
  network: {
    bindAddress: "127.0.0.1",
    allowInsecurePublic: false,
    allowedOrigins: [],
  },
  adapter: null,
  adapterOverrides: {},
  auth: {
    jwtSigningKey: null,
    tokenTtlSeconds: 31_536_000,
    maxAttemptsPerMinute: 5,
    reissueGraceSeconds: 600,
  },
  pairing: {
    maxPendingRequests: 100,
    maxRequestsPerMinute: 5,
    pendingTtlSeconds: 300,
  },
  media: {
    storagePath: defaultMediaPath,
    maxInlineBytes: 262_144,
    maxUploadBytes: 104_857_600,
    unreferencedUploadTtlSeconds: 3600,
  },
  sessions: {
    maxMessageBytes: 65_536,
    maxReplayMessages: 500,
    maxPromptMessages: 200,
    maxMessagesPerSecond: 5,
    maxTypingPerSecond: 2,
    typingAutoExpireSeconds: 10,
    maxQueuedMessages: 20,
    maxWriteQueueDepth: 1000,
    adapterExecuteTimeoutSeconds: 300,
    streamInactivitySeconds: 300,
  },
  streams: {
    chunkPersistIntervalMs: 100,
    chunkBufferBytes: 1_048_576,
  },
};

function deepMerge<T extends Record<string, any>>(
  target: T,
  source: Partial<T>,
): T {
  const targetRecord = target as Record<string, any>;
  const sourceRecord = source as Record<string, any>;
  for (const rawKey of Object.keys(sourceRecord)) {
    const key = rawKey as keyof T & string;
    const value = sourceRecord[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof targetRecord[key] === "object" &&
      targetRecord[key] !== null &&
      !Array.isArray(targetRecord[key])
    ) {
      targetRecord[key] = deepMerge(
        { ...(targetRecord[key] as Record<string, any>) },
        value,
      );
    } else if (value !== undefined) {
      targetRecord[key] = value;
    }
  }
  return target;
}

export function resolveClawlineConfig(
  cfg: ClawdbotConfig,
): ResolvedClawlineConfig {
  const input = (cfg.clawline ?? {}) as ClawlineConfigInput;
  const merged = deepMerge(
    structuredClone(DEFAULTS) as ResolvedClawlineConfig,
    input as Partial<ResolvedClawlineConfig>,
  );
  merged.statePath = merged.statePath || defaultStatePath;
  merged.media.storagePath = merged.media.storagePath || defaultMediaPath;
  const adapterOverrides: ClawlineAdapterOverrides = input.adapter
    ? { ...input.adapter }
    : {};
  merged.adapterOverrides = adapterOverrides;
  merged.enabled = input.enabled ?? true;
  return merged;
}
