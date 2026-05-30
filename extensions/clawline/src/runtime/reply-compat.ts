import type { OpenClawConfig } from "../runtime-api.js";

export type ClawlineResponsePrefixContext = {
  model?: string;
  modelFull?: string;
  provider?: string;
  thinkingLevel?: string;
  fastMode?: boolean;
  identityName?: string;
};

export type ClawlineQueueMode = "steer" | "followup" | "collect" | "interrupt";

export type ClawlineQueueDropPolicy = "old" | "new" | "summarize";

export type ClawlineQueueSettings = {
  mode: ClawlineQueueMode;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: ClawlineQueueDropPolicy;
};

const DEFAULT_QUEUE_DEBOUNCE_MS = 1000;
const DEFAULT_QUEUE_CAP = 20;
const DEFAULT_QUEUE_DROP: ClawlineQueueDropPolicy = "summarize";
const FOLLOWUP_QUEUES_KEY = Symbol.for("openclaw.followupQueues");

function normalizeLowercaseStringOrEmpty(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizeQueueMode(raw?: string): ClawlineQueueMode | undefined {
  const cleaned = normalizeLowercaseStringOrEmpty(raw);
  if (!cleaned) {
    return undefined;
  }
  if (cleaned === "queue" || cleaned === "queued") {
    return "steer";
  }
  if (cleaned === "interrupt" || cleaned === "interrupts" || cleaned === "abort") {
    return "interrupt";
  }
  if (cleaned === "steer" || cleaned === "steering") {
    return "steer";
  }
  if (cleaned === "followup" || cleaned === "follow-ups" || cleaned === "followups") {
    return "followup";
  }
  if (cleaned === "collect" || cleaned === "coalesce") {
    return "collect";
  }
  if (cleaned === "steer+backlog" || cleaned === "steer-backlog" || cleaned === "steer_backlog") {
    return "followup";
  }
  return undefined;
}

function normalizeQueueDropPolicy(raw?: string): ClawlineQueueDropPolicy | undefined {
  const cleaned = normalizeLowercaseStringOrEmpty(raw);
  if (!cleaned) {
    return undefined;
  }
  if (cleaned === "old" || cleaned === "oldest") {
    return "old";
  }
  if (cleaned === "new" || cleaned === "newest") {
    return "new";
  }
  if (cleaned === "summarize" || cleaned === "summary") {
    return "summarize";
  }
  return undefined;
}

export function extractClawlineShortModelName(fullModel: string): string {
  const slash = fullModel.lastIndexOf("/");
  const modelPart = slash >= 0 ? fullModel.slice(slash + 1) : fullModel;
  return modelPart.replace(/-\d{8}$/, "").replace(/-latest$/, "");
}

export function resolveClawlineQueueSettings(params: {
  cfg: OpenClawConfig;
  channel?: string;
  sessionEntry?: {
    queueMode?: string;
    queueDebounceMs?: number;
    queueCap?: number;
    queueDrop?: string;
  };
  inlineMode?: ClawlineQueueMode;
  inlineOptions?: Partial<ClawlineQueueSettings>;
}): ClawlineQueueSettings {
  const channelKey = normalizeLowercaseStringOrEmpty(params.channel);
  const queueCfg = params.cfg.messages?.queue;
  const providerModeRaw =
    channelKey && queueCfg?.byChannel
      ? (queueCfg.byChannel as Record<string, string | undefined>)[channelKey]
      : undefined;
  const debounceByChannel = queueCfg?.debounceMsByChannel as
    | Record<string, number | undefined>
    | undefined;
  const channelDebounce =
    channelKey && debounceByChannel ? debounceByChannel[channelKey] : undefined;
  const resolvedMode =
    params.inlineMode ??
    normalizeQueueMode(params.sessionEntry?.queueMode) ??
    normalizeQueueMode(providerModeRaw) ??
    normalizeQueueMode(queueCfg?.mode) ??
    "collect";
  const debounceRaw =
    params.inlineOptions?.debounceMs ??
    params.sessionEntry?.queueDebounceMs ??
    channelDebounce ??
    queueCfg?.debounceMs ??
    DEFAULT_QUEUE_DEBOUNCE_MS;
  const capRaw =
    params.inlineOptions?.cap ??
    params.sessionEntry?.queueCap ??
    queueCfg?.cap ??
    DEFAULT_QUEUE_CAP;
  const dropRaw =
    params.inlineOptions?.dropPolicy ??
    normalizeQueueDropPolicy(params.sessionEntry?.queueDrop) ??
    normalizeQueueDropPolicy(queueCfg?.drop) ??
    DEFAULT_QUEUE_DROP;
  return {
    mode: resolvedMode,
    debounceMs: typeof debounceRaw === "number" ? Math.max(0, debounceRaw) : undefined,
    cap: typeof capRaw === "number" ? Math.max(1, Math.floor(capRaw)) : undefined,
    dropPolicy: dropRaw,
  };
}

export function getClawlineFollowupQueueDepth(key: string): number {
  const cleaned = key.trim();
  if (!cleaned) {
    return 0;
  }
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const queues = globalStore[FOLLOWUP_QUEUES_KEY];
  if (!(queues instanceof Map)) {
    return 0;
  }
  const queue = queues.get(cleaned) as { items?: unknown[] } | undefined;
  return Array.isArray(queue?.items) ? queue.items.length : 0;
}
