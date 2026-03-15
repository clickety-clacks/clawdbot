import type { AgentMessage } from "@mariozechner/pi-agent-core";

export const PRUNED_HISTORY_IMAGE_MARKER = "[image data removed - already processed by model]";

type MessageContentBlock = { type?: string; text?: string };
type SessionMessageEntry = {
  type: "message";
  message?: AgentMessage;
};
type SessionEntryLike = {
  type?: string;
} & Partial<SessionMessageEntry>;
type SessionManagerLike = {
  getBranch(fromId?: string | null): SessionEntryLike[];
  getLeafId(): string | null;
  _rewriteFile?: () => void;
};

function isSessionManagerLike(value: unknown): value is SessionManagerLike {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    getBranch?: unknown;
    getLeafId?: unknown;
  };
  return typeof candidate.getBranch === "function" && typeof candidate.getLeafId === "function";
}

function pruneMessageImages(message: AgentMessage): boolean {
  if (message.role !== "user" || !Array.isArray(message.content)) {
    return false;
  }

  let didMutate = false;
  for (let j = 0; j < message.content.length; j++) {
    const block = message.content[j];
    if (!block || typeof block !== "object") {
      continue;
    }
    if ((block as MessageContentBlock).type !== "image") {
      continue;
    }
    message.content[j] = {
      type: "text",
      text: PRUNED_HISTORY_IMAGE_MARKER,
    } as (typeof message.content)[number];
    didMutate = true;
  }

  return didMutate;
}

/**
 * Idempotent cleanup for legacy sessions that persisted image blocks in history.
 * Called each run; mutates only user turns that already have an assistant reply.
 */
export function pruneProcessedHistoryImages(messages: AgentMessage[]): boolean {
  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }
  if (lastAssistantIndex < 0) {
    return false;
  }

  let didMutate = false;
  for (let i = 0; i < lastAssistantIndex; i++) {
    const message = messages[i];
    if (!message) {
      continue;
    }
    didMutate = pruneMessageImages(message) || didMutate;
  }

  return didMutate;
}

/**
 * Durable cleanup for persisted sessions. Prunes image blocks from the current branch's
 * already-answered user turns, then rewrites the session file so later runs do not reload
 * the stale image payloads from disk.
 */
export function pruneProcessedHistoryImagesInSession(sessionManager: unknown): boolean {
  if (!isSessionManagerLike(sessionManager)) {
    return false;
  }
  const path = sessionManager.getBranch(sessionManager.getLeafId());
  let lastAssistantIndex = -1;
  for (let i = path.length - 1; i >= 0; i--) {
    const entry = path[i];
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }
  if (lastAssistantIndex < 0) {
    return false;
  }

  let didMutate = false;
  for (let i = 0; i < lastAssistantIndex; i++) {
    const entry = path[i];
    if (entry?.type !== "message" || !entry.message) {
      continue;
    }
    didMutate = pruneMessageImages(entry.message) || didMutate;
  }

  if (didMutate) {
    sessionManager._rewriteFile?.();
  }
  return didMutate;
}
