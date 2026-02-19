export type ClawlineAdapterConfig = {
  provider?: string;
  model?: string;
  timeoutSeconds?: number;
  responseFallback?: string;
  systemPrompt?: string;
};

export type ClawlineConfig = {
  enabled?: boolean;
  port?: number;
  statePath?: string;
  alertInstructionsPath?: string | null;
  network?: {
    bindAddress?: string;
    allowInsecurePublic?: boolean;
    allowedOrigins?: string[];
  };
  adapter?: ClawlineAdapterConfig;
  auth?: {
    jwtSigningKey?: string | null;
    tokenTtlSeconds?: number | null;
    maxAttemptsPerMinute?: number;
    reissueGraceSeconds?: number;
  };
  pairing?: {
    maxPendingRequests?: number;
    maxRequestsPerMinute?: number;
    pendingTtlSeconds?: number;
    pendingSocketTimeoutSeconds?: number;
  };
  media?: {
    storagePath?: string;
    maxInlineBytes?: number;
    maxUploadBytes?: number;
    unreferencedUploadTtlSeconds?: number;
  };
  sessions?: {
    maxMessageBytes?: number;
    maxReplayMessages?: number;
    maxPromptMessages?: number;
    maxMessagesPerSecond?: number;
    maxTypingPerSecond?: number;
    typingAutoExpireSeconds?: number;
    maxQueuedMessages?: number;
    maxWriteQueueDepth?: number;
    adapterExecuteTimeoutSeconds?: number;
    streamInactivitySeconds?: number;
  };
  streams?: {
    chunkPersistIntervalMs?: number;
    chunkBufferBytes?: number;
    maxStreamsPerUser?: number;
    maxDisplayNameBytes?: number;
  };
};
