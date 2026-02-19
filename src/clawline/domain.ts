import type { getReplyFromConfig } from "../auto-reply/reply.js";
import type { OpenClawConfig } from "../config/config.js";

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
  | { type: "asset"; assetId: string }
  | { type: "document"; mimeType: string; data: string };

export type StreamSessionKind = "main" | "dm" | "global_dm" | "custom";

export type StreamSession = {
  sessionKey: string;
  displayName: string;
  kind: StreamSessionKind;
  orderIndex: number;
  isBuiltIn: boolean;
  createdAt: number;
  updatedAt: number;
};

export type StreamSnapshotServerMessage = {
  type: "stream_snapshot";
  streams: StreamSession[];
};

export type StreamCreatedServerMessage = {
  type: "stream_created";
  stream: StreamSession;
};

export type StreamUpdatedServerMessage = {
  type: "stream_updated";
  stream: StreamSession;
};

export type StreamDeletedServerMessage = {
  type: "stream_deleted";
  sessionKey: string;
};

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
  terminal: {
    tmux: {
      /**
       * Where tmux lives relative to the provider process.
       * - local: tmux is available on the provider host.
       * - ssh: provider uses SSH to a remote terminal host and runs tmux there.
       */
      mode: "local" | "ssh";
      ssh: {
        /**
         * SSH target in OpenSSH form (e.g. "user@host" or "host").
         * Only used when mode="ssh".
         */
        target: string;
        /** Identity file path passed as `ssh -i`. Optional. */
        identityFile?: string | null;
        /** SSH port. Optional. */
        port?: number | null;
        /** UserKnownHostsFile override. Optional. */
        knownHostsFile?: string | null;
        /**
         * StrictHostKeyChecking mode. Defaults are chosen by the deployment.
         * Common values: "yes", "no", "accept-new".
         */
        strictHostKeyChecking?: "yes" | "no" | "accept-new" | null;
        /**
         * Additional raw ssh args (advanced escape hatch).
         * Example: ["-o", "ProxyCommand=..."]
         */
        extraArgs?: string[];
      };
    };
  };
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
  webRootPath: string;
  webRoot: {
    /**
     * When enabled, allow webroot paths that resolve (via symlinks) outside the webroot.
     * Dotfiles and traversal remain blocked at the request level.
     */
    followSymlinks: boolean;
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
    maxStreamsPerUser: number;
    maxDisplayNameBytes: number;
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
  /** Session key for this delivery (optional; otherwise derived from target). */
  sessionKey?: string;
};

export type ClawlineOutboundSendResult = {
  messageId: string;
  userId: string;
  deviceId?: string;
  attachments?: NormalizedAttachment[];
  assetIds?: string[];
};
