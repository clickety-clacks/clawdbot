import type { SessionChannelId, SessionEntry } from "../config/sessions.js";
import { mergeSessionEntry, updateSessionStore } from "../config/sessions.js";

export const CLAWLINE_SESSION_CHANNEL = "clawline" as SessionChannelId;

type LoggerLike = { warn?: (...args: unknown[]) => void };

export async function recordClawlineSessionActivity(params: {
  storePath: string;
  sessionKey: string;
  sessionId: string;
  sessionFile?: string;
  displayName?: string | null;
  logger?: LoggerLike;
}): Promise<void> {
  const { storePath, sessionKey, sessionId, sessionFile, displayName } = params;
  const label = displayName?.trim() ? displayName.trim() : undefined;
  try {
    // Use updateSessionStore to atomically load-modify-write under lock.
    // This prevents race conditions with concurrent updateLastRoute writes.
    await updateSessionStore(storePath, (store) => {
      const existing = store[sessionKey];
      const patch: Partial<SessionEntry> = {
        sessionId,
        channel: CLAWLINE_SESSION_CHANNEL,
        chatType: "direct",
        displayName: label,
        label,
        sessionFile,
        lastChannel: CLAWLINE_SESSION_CHANNEL,
      };
      // Don't set lastTo on connect; only update it after an actual user message.
      store[sessionKey] = mergeSessionEntry(existing, patch);
    });
  } catch (err) {
    params.logger?.warn?.("[clawline] failed to update session store", err);
  }
}

export async function updateClawlineSessionDeliveryTarget(params: {
  storePath: string;
  sessionKey: string;
  logger?: LoggerLike;
}): Promise<void> {
  const { storePath, sessionKey } = params;
  try {
    await updateSessionStore(storePath, (store) => {
      const existing = store[sessionKey];
      const patch: Partial<SessionEntry> = {
        lastChannel: CLAWLINE_SESSION_CHANNEL,
        lastTo: sessionKey,
      };
      // Set lastTo only when the user actually sends from this session.
      store[sessionKey] = mergeSessionEntry(existing, patch);
    });
  } catch (err) {
    params.logger?.warn?.("[clawline] failed to update session delivery target", err);
  }
}
