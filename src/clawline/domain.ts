import type { OpenClawConfig } from "../config/config.js";
import type { getReplyFromConfig } from "../auto-reply/reply.js";

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
  bindingId?: string;
  isAdmin: boolean;
  tokenDelivered: boolean;
  createdAt: number;
  lastSeenAt: number | null;
};

export type AllowlistFile = { version: 1; entries: AllowlistEntry[] };

export type NormalizedAttachment =
  | { type: "image"; mimeType: string; data: string; assetId?: string }
  | { type: "asset"; assetId: string };
export type ClawlineOutboundAttachmentInput = {
  data: string;
  mimeType?: string;
};
export type PendingEntry = {
  deviceId: string;
  claimedName?: string;
  deviceInfo: DeviceInfo;
  requestedAt: number;
};

export type PendingFile = { version: 1; entries: PendingEntry[] };

export interface ProviderConfig {
  port: number;
  statePath: string;
  alertInstructionsPath?: string | null;
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
  openClawConfig: OpenClawConfig;
  replyResolver?: typeof getReplyFromConfig;
  logger?: Logger;
  sessionStorePath: string;
  mainSessionKey?: string;
}

export interface ProviderServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  getPort(): number;
  sendMessage(params: ClawlineOutboundSendParams): Promise<ClawlineOutboundSendResult>;
}

export type Logger = Pick<typeof console, "info" | "warn" | "error">;

export type ClawlineOutboundSendParams = {
  target: string;
  text: string;
  mediaUrl?: string;
  attachments?: ClawlineOutboundAttachmentInput[];
  /**
   * Override channel type for delivery (backward compat if sessionKey is omitted).
   */
  channelType?: "admin" | "personal";
  /** Session key for this delivery (preferred when provided). */
  sessionKey?: string;
};

export type ClawlineOutboundSendResult = {
  messageId: string;
  userId: string;
  deviceId?: string;
  attachments?: NormalizedAttachment[];
  assetIds?: string[];
};
