import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { ProviderConfig } from "./domain.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../agents/workspace.js";
import { resolveUserPath } from "../utils.js";
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

type ProviderConfigBase = Omit<ProviderConfig, "adapter" | "webRoot">;

export type ClawlineConfigInput = {
  enabled?: boolean;
  adapter?: ClawlineAdapterOverrides;
  webRootPath?: string;
  webRoot?: {
    followSymlinks?: boolean;
  };
} & Partial<ProviderConfigBase>;

const defaultStatePath = path.join(os.homedir(), ".openclaw", "clawline");
const defaultMediaPath = path.join(os.homedir(), ".openclaw", "clawline-media");
const defaultAlertInstructionsPath = path.join(
  os.homedir(),
  ".openclaw",
  "clawline",
  "alert-instructions.md",
);

function expandUserPath(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function resolvePathValue(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  const raw = trimmed && trimmed.length > 0 ? trimmed : fallback;
  const expanded = expandUserPath(raw);
  return path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
}

const DEFAULTS: ResolvedClawlineConfig = {
  enabled: false,
  port: 18800,
  statePath: defaultStatePath,
  alertInstructionsPath: defaultAlertInstructionsPath,
  terminal: {
    tmux: {
      mode: "local",
      ssh: {
        target: "",
        identityFile: null,
        port: null,
        knownHostsFile: null,
        strictHostKeyChecking: "accept-new",
        extraArgs: [],
      },
    },
  },
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
  webRootPath: path.join(DEFAULT_AGENT_WORKSPACE_DIR, "www"),
  webRoot: {
    followSymlinks: false,
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

export function resolveClawlineConfig(cfg: OpenClawConfig): ResolvedClawlineConfig {
  const input = (cfg.channels?.clawline ?? {}) as ClawlineConfigInput;
  const merged = deepMerge(structuredClone(DEFAULTS), input as Partial<ResolvedClawlineConfig>);
  merged.statePath = resolvePathValue(merged.statePath, defaultStatePath);
  merged.media.storagePath = resolvePathValue(merged.media.storagePath, defaultMediaPath);
  const workspaceDefault =
    typeof cfg.agents?.defaults?.workspace === "string" &&
    cfg.agents.defaults.workspace.trim().length > 0
      ? resolveUserPath(cfg.agents.defaults.workspace)
      : DEFAULT_AGENT_WORKSPACE_DIR;
  const defaultWebRootPath = path.join(workspaceDefault, "www");
  merged.webRootPath = resolvePathValue(merged.webRootPath, defaultWebRootPath);
  if (
    Object.prototype.hasOwnProperty.call(input, "alertInstructionsPath") &&
    input.alertInstructionsPath === null
  ) {
    merged.alertInstructionsPath = null;
  } else {
    merged.alertInstructionsPath = resolvePathValue(
      merged.alertInstructionsPath ?? defaultAlertInstructionsPath,
      defaultAlertInstructionsPath,
    );
  }
  const adapterOverrides: ClawlineAdapterOverrides = input.adapter ? { ...input.adapter } : {};
  merged.adapterOverrides = adapterOverrides;
  merged.enabled = input.enabled === true;
  return merged;
}
