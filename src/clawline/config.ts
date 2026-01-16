import os from "node:os";
import path from "node:path";

import type { ClawdbotConfig } from "../config/config.js";
import type { ProviderConfig } from "./domain.js";
import { deepMerge } from "./utils/deep-merge.js";

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
  port: 18800,
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
    pendingSocketTimeoutSeconds: 300,
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
  const adapterOverrides: ClawlineAdapterOverrides = {
    ...(input.adapter ?? {}),
  };
  merged.adapterOverrides = adapterOverrides;
  merged.enabled = input.enabled ?? true;
  return merged;
}
