import { z } from "zod";

export const ClawlineAdapterSchema = z
  .object({
    provider: z.string().optional(),
    model: z.string().optional(),
    timeoutSeconds: z.number().int().nonnegative().optional(),
    responseFallback: z.string().optional(),
    systemPrompt: z.string().optional(),
  })
  .strict()
  .optional();

export const ClawlineSchema = z
  .object({
    enabled: z.boolean().optional(),
    port: z.number().int().positive().optional(),
    statePath: z.string().optional(),
    alertInstructionsPath: z.string().optional(),
    network: z
      .object({
        bindAddress: z.string().optional(),
        allowInsecurePublic: z.boolean().optional(),
        allowedOrigins: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    adapter: ClawlineAdapterSchema,
    auth: z
      .object({
        jwtSigningKey: z.string().nullable().optional(),
        tokenTtlSeconds: z.number().int().nonnegative().nullable().optional(),
        maxAttemptsPerMinute: z.number().int().nonnegative().optional(),
        reissueGraceSeconds: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    pairing: z
      .object({
        maxPendingRequests: z.number().int().nonnegative().optional(),
        maxRequestsPerMinute: z.number().int().nonnegative().optional(),
        pendingTtlSeconds: z.number().int().nonnegative().optional(),
        pendingSocketTimeoutSeconds: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    media: z
      .object({
        storagePath: z.string().optional(),
        maxInlineBytes: z.number().int().nonnegative().optional(),
        maxUploadBytes: z.number().int().nonnegative().optional(),
        unreferencedUploadTtlSeconds: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    sessions: z
      .object({
        maxMessageBytes: z.number().int().nonnegative().optional(),
        maxReplayMessages: z.number().int().nonnegative().optional(),
        maxPromptMessages: z.number().int().nonnegative().optional(),
        maxMessagesPerSecond: z.number().int().nonnegative().optional(),
        maxTypingPerSecond: z.number().int().nonnegative().optional(),
        typingAutoExpireSeconds: z.number().int().nonnegative().optional(),
        maxQueuedMessages: z.number().int().nonnegative().optional(),
        maxWriteQueueDepth: z.number().int().nonnegative().optional(),
        adapterExecuteTimeoutSeconds: z.number().int().nonnegative().optional(),
        streamInactivitySeconds: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    streams: z
      .object({
        chunkPersistIntervalMs: z.number().int().nonnegative().optional(),
        chunkBufferBytes: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();
