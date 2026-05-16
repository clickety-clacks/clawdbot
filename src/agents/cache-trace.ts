import crypto from "node:crypto";
import path from "node:path";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { diagnosticErrorCategory } from "../infra/diagnostic-error-metadata.js";
import { resolveUserPath } from "../utils.js";
import { parseBooleanValue } from "../utils/boolean.js";
import { safeJsonStringify } from "../utils/safe-json.js";
import { sanitizeDiagnosticPayload } from "./payload-redaction.js";
import { getQueuedFileWriter, type QueuedFileWriter } from "./queued-file-writer.js";
import { stableStringify } from "./stable-stringify.js";
import { buildAgentTraceBase } from "./trace-base.js";

type CacheTraceStage =
  | "cache:result"
  | "cache:state"
  | "model:call:end"
  | "model:call:error"
  | "model:call:first-byte"
  | "model:call:start"
  | "prompt:submit:after"
  | "prompt:submit:before"
  | "runner:core-plugin-tool-stages"
  | "runner:prep-stages"
  | "runner:startup-stages"
  | "session:loaded"
  | "session:raw-model-run"
  | "session:sanitized"
  | "session:limited"
  | "prompt:before"
  | "prompt:images"
  | "stream:context"
  | "tool:execution:end"
  | "tool:execution:start"
  | "session:after";

type CacheTraceEvent = {
  ts: string;
  seq: number;
  stage: CacheTraceStage;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
  prompt?: string;
  system?: unknown;
  options?: Record<string, unknown>;
  model?: Record<string, unknown>;
  messages?: AgentMessage[];
  messageCount?: number;
  messageRoles?: Array<string | undefined>;
  messageFingerprints?: string[];
  messagesDigest?: string;
  systemDigest?: string;
  timing?: {
    phase?: string;
    totalMs: number;
    stages: Array<{
      name: string;
      durationMs: number;
      elapsedMs: number;
    }>;
  };
  note?: string;
  error?: string;
};

type CacheTrace = {
  enabled: true;
  filePath: string;
  recordStage: (stage: CacheTraceStage, payload?: Partial<CacheTraceEvent>) => void;
  recordToolExecution: (payload: {
    phase: "start" | "end";
    toolName?: string;
    isError?: boolean;
    durationMs?: number;
  }) => void;
  wrapStreamFn: (streamFn: StreamFn) => StreamFn;
};

type CacheTraceInit = {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  workspaceDir?: string;
  writer?: CacheTraceWriter;
};

type CacheTraceConfig = {
  enabled: boolean;
  filePath: string;
  includeMessages: boolean;
  includePrompt: boolean;
  includeSystem: boolean;
};

type CacheTraceWriter = QueuedFileWriter;

const writers = new Map<string, CacheTraceWriter>();
const sequenceByTraceKey = new Map<string, number>();
const CACHE_TRACE_STREAM_RETURN_TIMEOUT_MS = 1000;

async function safeReturnIterator(iterator: AsyncIterator<unknown>): Promise<void> {
  let returnResult: unknown;
  try {
    returnResult = iterator.return?.();
  } catch {
    return;
  }
  if (!returnResult) {
    return;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve(returnResult).catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, CACHE_TRACE_STREAM_RETURN_TIMEOUT_MS);
        const unref =
          typeof timeout === "object" && timeout
            ? (timeout as { unref?: () => void }).unref
            : undefined;
        unref?.call(timeout);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function resolveCacheTraceConfig(params: CacheTraceInit): CacheTraceConfig {
  const env = params.env ?? process.env;
  const config = params.cfg?.diagnostics?.cacheTrace;
  const envEnabled = parseBooleanValue(env.OPENCLAW_CACHE_TRACE);
  const enabled = envEnabled ?? config?.enabled ?? false;
  const fileOverride = config?.filePath?.trim() || env.OPENCLAW_CACHE_TRACE_FILE?.trim();
  const filePath = fileOverride
    ? resolveUserPath(fileOverride)
    : path.join(resolveStateDir(env), "logs", "cache-trace.jsonl");

  const includeMessages =
    parseBooleanValue(env.OPENCLAW_CACHE_TRACE_MESSAGES) ?? config?.includeMessages;
  const includePrompt = parseBooleanValue(env.OPENCLAW_CACHE_TRACE_PROMPT) ?? config?.includePrompt;
  const includeSystem = parseBooleanValue(env.OPENCLAW_CACHE_TRACE_SYSTEM) ?? config?.includeSystem;

  return {
    enabled,
    filePath,
    includeMessages: includeMessages ?? true,
    includePrompt: includePrompt ?? true,
    includeSystem: includeSystem ?? true,
  };
}

function getWriter(filePath: string): CacheTraceWriter {
  return getQueuedFileWriter(writers, filePath);
}

function digest(value: unknown): string {
  const serialized = stableStringify(value);
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

function summarizeMessages(messages: AgentMessage[]): {
  messageCount: number;
  messageRoles: Array<string | undefined>;
  messageFingerprints: string[];
  messagesDigest: string;
} {
  const messageFingerprints = messages.map((msg) => digest(msg));
  return {
    messageCount: messages.length,
    messageRoles: messages.map((msg) => (msg as { role?: string }).role),
    messageFingerprints,
    messagesDigest: digest(messageFingerprints.join("|")),
  };
}

function isRunnerTimingStage(stage: CacheTraceStage): boolean {
  return stage.startsWith("runner:");
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  try {
    return typeof (value as { then?: unknown }).then === "function";
  } catch {
    return false;
  }
}

function asyncIteratorFactory(value: unknown): (() => AsyncIterator<unknown>) | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  try {
    const asyncIterator = (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator];
    if (typeof asyncIterator !== "function") {
      return undefined;
    }
    return () => asyncIterator.call(value) as AsyncIterator<unknown>;
  } catch {
    return undefined;
  }
}

function observeStreamResult<T extends AsyncIterable<unknown>>(
  stream: T,
  createIterator: () => AsyncIterator<unknown>,
  onFirstByte: () => void,
  onComplete: (error?: unknown) => void,
): T {
  const observedIterator = async function* () {
    const iterator = createIterator();
    let observedFirstByte = false;
    let terminalRecorded = false;
    const recordComplete = (error?: unknown) => {
      if (terminalRecorded) {
        return;
      }
      terminalRecorded = true;
      onComplete(error);
    };
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          break;
        }
        if (!observedFirstByte) {
          observedFirstByte = true;
          onFirstByte();
        }
        yield next.value;
      }
      recordComplete();
    } catch (err) {
      recordComplete(err);
      throw err;
    } finally {
      if (!terminalRecorded) {
        await safeReturnIterator(iterator);
        recordComplete();
      }
    }
  };

  let hasNonConfigurableIterator = false;
  try {
    hasNonConfigurableIterator =
      Object.getOwnPropertyDescriptor(stream, Symbol.asyncIterator)?.configurable === false;
  } catch {
    hasNonConfigurableIterator = true;
  }
  if (hasNonConfigurableIterator) {
    return {
      [Symbol.asyncIterator]: observedIterator,
    } as unknown as T;
  }
  return new Proxy(stream, {
    get(target, property, receiver) {
      if (property === Symbol.asyncIterator) {
        return observedIterator;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function createCacheTrace(params: CacheTraceInit): CacheTrace | null {
  const cfg = resolveCacheTraceConfig(params);
  if (!cfg.enabled) {
    return null;
  }

  const writer = params.writer ?? getWriter(cfg.filePath);
  const sequenceKey = params.runId ? `${cfg.filePath}\0${params.runId}` : undefined;
  let seq = 0;
  const nextSequence = () => {
    if (!sequenceKey) {
      return (seq += 1);
    }
    const next = (sequenceByTraceKey.get(sequenceKey) ?? 0) + 1;
    sequenceByTraceKey.set(sequenceKey, next);
    return next;
  };

  const base: Omit<CacheTraceEvent, "ts" | "seq" | "stage"> = buildAgentTraceBase(params);

  const recordStage: CacheTrace["recordStage"] = (stage, payload = {}) => {
    const runnerTimingStage = isRunnerTimingStage(stage);
    const event: CacheTraceEvent = {
      ...(runnerTimingStage ? { runId: base.runId } : base),
      ts: new Date().toISOString(),
      seq: nextSequence(),
      stage,
    };

    if (!runnerTimingStage && payload.prompt !== undefined && cfg.includePrompt) {
      event.prompt = payload.prompt;
    }
    if (!runnerTimingStage && payload.system !== undefined && cfg.includeSystem) {
      event.system = sanitizeDiagnosticPayload(payload.system);
      event.systemDigest = digest(payload.system);
    }
    if (!runnerTimingStage && payload.options) {
      event.options = sanitizeDiagnosticPayload(payload.options) as Record<string, unknown>;
    }
    if (!runnerTimingStage && payload.model) {
      event.model = sanitizeDiagnosticPayload(payload.model) as Record<string, unknown>;
    }
    if (payload.timing) {
      event.timing = sanitizeDiagnosticPayload(payload.timing) as CacheTraceEvent["timing"];
    }

    const messages = payload.messages;
    if (!runnerTimingStage && Array.isArray(messages)) {
      const summary = summarizeMessages(messages);
      event.messageCount = summary.messageCount;
      event.messageRoles = summary.messageRoles;
      event.messageFingerprints = summary.messageFingerprints;
      event.messagesDigest = summary.messagesDigest;
      if (cfg.includeMessages) {
        event.messages = sanitizeDiagnosticPayload(messages) as AgentMessage[];
      }
    }

    if (!runnerTimingStage && payload.note) {
      event.note = payload.note;
    }
    if (!runnerTimingStage && payload.error) {
      event.error = payload.error;
    }

    const line = safeJsonStringify(event);
    if (!line) {
      return;
    }
    writer.write(`${line}\n`);
  };

  const recordToolExecution: CacheTrace["recordToolExecution"] = (payload) => {
    const toolName = typeof payload.toolName === "string" ? payload.toolName.trim() : "";
    recordStage(payload.phase === "start" ? "tool:execution:start" : "tool:execution:end", {
      options: {
        ...(toolName ? { toolName } : {}),
        ...(typeof payload.durationMs === "number" && Number.isFinite(payload.durationMs)
          ? { durationMs: Math.max(0, Math.round(payload.durationMs)) }
          : {}),
        ...(typeof payload.isError === "boolean" ? { isError: payload.isError } : {}),
      },
    });
  };

  const wrapStreamFn: CacheTrace["wrapStreamFn"] = (streamFn) => {
    const wrapped: StreamFn = (model, context, options) => {
      const startedAt = Date.now();
      let firstByteAt: number | undefined;
      let terminalRecorded = false;
      const recordTerminal = (error?: unknown) => {
        if (terminalRecorded) {
          return;
        }
        terminalRecorded = true;
        recordStage(error === undefined ? "model:call:end" : "model:call:error", {
          options: {
            durationMs: Math.max(0, Date.now() - startedAt),
            ...(firstByteAt !== undefined
              ? { timeToFirstByteMs: Math.max(0, firstByteAt - startedAt) }
              : {}),
            ...(error !== undefined ? { errorCategory: diagnosticErrorCategory(error) } : {}),
          },
        });
      };
      recordStage("model:call:start", {
        model: {
          id: model?.id,
          provider: model?.provider,
          api: model?.api,
        },
      });
      const traceContext = context as {
        messages?: AgentMessage[];
        system?: unknown;
        systemPrompt?: unknown;
      };
      recordStage("stream:context", {
        model: {
          id: model?.id,
          provider: model?.provider,
          api: model?.api,
        },
        system: traceContext.systemPrompt ?? traceContext.system,
        messages: traceContext.messages ?? [],
        options: (options ?? {}) as Record<string, unknown>,
      });

      const observeResult = (result: unknown): unknown => {
        const createIterator = asyncIteratorFactory(result);
        if (!createIterator) {
          recordTerminal();
          return result;
        }
        return observeStreamResult(
          result as AsyncIterable<unknown>,
          createIterator,
          () => {
            firstByteAt = Date.now();
            recordStage("model:call:first-byte", {
              options: {
                timeToFirstByteMs: Math.max(0, firstByteAt - startedAt),
              },
            });
          },
          recordTerminal,
        );
      };

      try {
        const result = streamFn(model, context, options);
        if (isPromiseLike(result)) {
          return result.then(
            (resolved) => observeResult(resolved),
            (err) => {
              recordTerminal(err);
              throw err;
            },
          ) as ReturnType<StreamFn>;
        }
        return observeResult(result) as ReturnType<StreamFn>;
      } catch (err) {
        recordTerminal(err);
        throw err;
      }
    };
    return wrapped;
  };

  return {
    enabled: true,
    filePath: cfg.filePath,
    recordStage,
    recordToolExecution,
    wrapStreamFn,
  };
}
