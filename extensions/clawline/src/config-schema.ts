import { z } from "zod";

const NetworkSchema = z
  .object({
    bindAddress: z.string().optional(),
    allowInsecurePublic: z.boolean().optional(),
    allowedOrigins: z.array(z.string()).optional(),
  })
  .strict()
  .optional();

const AdapterSchema = z
  .object({
    provider: z.string().optional(),
    model: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    responseFallback: z.string().optional(),
    systemPrompt: z.string().optional(),
  })
  .strict()
  .optional();

const AuthSchema = z
  .object({
    jwtSigningKey: z.string().nullable().optional(),
    tokenTtlSeconds: z.number().int().positive().nullable().optional(),
    maxAttemptsPerMinute: z.number().int().positive().optional(),
    reissueGraceSeconds: z.number().int().nonnegative().optional(),
  })
  .strict()
  .optional();

const PairingSchema = z
  .object({
    maxPendingRequests: z.number().int().positive().optional(),
    maxRequestsPerMinute: z.number().int().positive().optional(),
    pendingTtlSeconds: z.number().int().positive().optional(),
    pendingSocketTimeoutSeconds: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

const MediaSchema = z
  .object({
    storagePath: z.string().optional(),
    maxInlineBytes: z.number().int().positive().optional(),
    maxUploadBytes: z.number().int().positive().optional(),
    unreferencedUploadTtlSeconds: z.number().int().nonnegative().optional(),
  })
  .strict()
  .optional();

const SessionsSchema = z
  .object({
    maxMessageBytes: z.number().int().positive().optional(),
    maxReplayMessages: z.number().int().positive().optional(),
    maxPromptMessages: z.number().int().positive().optional(),
    maxMessagesPerSecond: z.number().int().positive().optional(),
    maxTypingPerSecond: z.number().int().positive().optional(),
    typingAutoExpireSeconds: z.number().int().positive().optional(),
    maxQueuedMessages: z.number().int().positive().optional(),
    maxWriteQueueDepth: z.number().int().positive().optional(),
    adapterExecuteTimeoutSeconds: z.number().int().positive().optional(),
    streamInactivitySeconds: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

const StreamsSchema = z
  .object({
    chunkPersistIntervalMs: z.number().int().positive().optional(),
    chunkBufferBytes: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

export const ClawlineConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    statePath: z.string().optional(),
    alertInstructionsPath: z.string().nullable().optional(),
    webRootPath: z.string().optional(),
    network: NetworkSchema,
    adapter: AdapterSchema,
    auth: AuthSchema,
    pairing: PairingSchema,
    media: MediaSchema,
    sessions: SessionsSchema,
    streams: StreamsSchema,
  })
  .strict();
