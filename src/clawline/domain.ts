export type DeviceInfo = {
  platform: string;
  model: string;
  osVersion?: string;
  appVersion?: string;
};

export type AllowlistEntry = {
  deviceId: string;
  claimedName?: string;
  deviceInfo: DeviceInfo;
  userId: string;
  isAdmin: boolean;
  tokenDelivered: boolean;
  createdAt: number;
  lastSeenAt: number | null;
};

export type AllowlistFile = { version: 1; entries: AllowlistEntry[] };

export type PendingEntry = {
  deviceId: string;
  claimedName?: string;
  deviceInfo: DeviceInfo;
  requestedAt: number;
};

export type PendingFile = { version: 1; entries: PendingEntry[] };

export type NormalizedAttachment =
  | { type: "image"; mimeType: string; data: string }
  | { type: "asset"; assetId: string };

export type AdapterExecuteParams = {
  prompt: string;
  userId: string;
  sessionId: string;
  deviceId: string;
};

export interface Adapter {
  capabilities?: { streaming?: boolean };
  execute: (
    params: AdapterExecuteParams
  ) => Promise<{ exitCode: number; output: string } | { exitCode?: number; output?: string } | string>;
}

export interface ProviderConfig {
  port: number;
  statePath: string;
  network: {
    bindAddress: string;
    allowInsecurePublic: boolean;
    allowedOrigins?: string[];
  };
  adapter?: string | null;
  auth: {
    jwtSigningKey?: string | null;
    tokenTtlSeconds: number | null;
    maxAttemptsPerMinute: number;
    reissueGraceSeconds: number;
  };
  pairing: {
    maxPendingRequests: number;
    maxRequestsPerMinute: number;
    pendingTtlSeconds: number;
    pendingSocketTimeoutSeconds: number;
  };
  media: {
    storagePath: string;
    maxInlineBytes: number;
    maxUploadBytes: number;
    unreferencedUploadTtlSeconds: number;
  };
  sessions: {
    maxMessageBytes: number;
    maxReplayMessages: number;
    maxPromptMessages: number;
    maxMessagesPerSecond: number;
    maxTypingPerSecond: number;
    typingAutoExpireSeconds: number;
    maxQueuedMessages: number;
    maxWriteQueueDepth: number;
    adapterExecuteTimeoutSeconds: number;
    streamInactivitySeconds: number;
  };
  streams: {
    chunkPersistIntervalMs: number;
    chunkBufferBytes: number;
  };
}

export interface ProviderOptions {
  config?: Partial<ProviderConfig>;
  adapter: Adapter;
  logger?: Logger;
  sessionStorePath: string;
}

export interface ProviderServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  getPort(): number;
}

export type Logger = Pick<typeof console, "info" | "warn" | "error">;
