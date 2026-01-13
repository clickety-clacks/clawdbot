import type { SessionEntry, SessionProviderId } from "../config/sessions.js";
import { upsertSessionStoreEntry } from "../config/sessions.js";

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
    await upsertSessionStoreEntry({
      storePath,
      sessionKey,
      patch: {
        sessionId,
        provider: CLAWLINE_SESSION_PROVIDER,
        chatType: "direct",
        displayName: label,
        label,
        sessionFile,
        lastProvider: CLAWLINE_SESSION_PROVIDER,
      } satisfies Partial<SessionEntry>,
    });
  } catch (err) {
    params.logger?.warn?.("[clawline] failed to update session store", err);
  }
}
