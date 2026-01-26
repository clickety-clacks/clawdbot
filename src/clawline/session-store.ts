import type { SessionChannelId, SessionEntry } from "../config/sessions.js";
import { mergeSessionEntry, updateSessionStore } from "../config/sessions.js";

export const CLAWLINE_SESSION_PROVIDER = "clawline" as SessionProviderId;

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
      store[sessionKey] = mergeSessionEntry(existing, patch);
    });
  } catch (err) {
    params.logger?.warn?.("[clawline] failed to update session store", err);
  }
}
