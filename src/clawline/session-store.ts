import path from "node:path";
import type { SessionChannelId, SessionEntry } from "../config/sessions.js";
import {
  mergeSessionEntry,
  resolveAgentIdFromSessionKey,
  resolveSessionTranscriptPath,
  resolveSessionTranscriptsDirForAgent,
  updateSessionStore,
} from "../config/sessions.js";

export const CLAWLINE_SESSION_CHANNEL = "clawline" as SessionChannelId;

type LoggerLike = { warn?: (...args: unknown[]) => void };

function isWithinDir(filePath: string, directory: string): boolean {
  const resolvedFile = path.resolve(filePath);
  const resolvedDir = path.resolve(directory);
  if (resolvedFile === resolvedDir) {
    return true;
  }
  const prefix = resolvedDir.endsWith(path.sep) ? resolvedDir : `${resolvedDir}${path.sep}`;
  return resolvedFile.startsWith(prefix);
}

export async function recordClawlineSessionActivity(params: {
  storePath: string;
  sessionKey: string;
  sessionId: string;
  sessionFile?: string;
  displayName?: string | null;
  logger?: LoggerLike;
}): Promise<void> {
  const { storePath, sessionKey, sessionId, displayName } = params;
  const label = displayName?.trim() ? displayName.trim() : undefined;
  try {
    // Use updateSessionStore to atomically load-modify-write under lock.
    // This prevents race conditions with concurrent updateLastRoute writes.
    await updateSessionStore(storePath, (store) => {
      const existing = store[sessionKey];
      const stableSessionId = existing?.sessionId ?? sessionId;
      const agentId = resolveAgentIdFromSessionKey(sessionKey);
      const canonicalSessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
      const canonicalSessionFile = resolveSessionTranscriptPath(stableSessionId, agentId);
      const existingSessionFile = existing?.sessionFile?.trim();
      const stableSessionFile =
        existingSessionFile && isWithinDir(existingSessionFile, canonicalSessionsDir)
          ? existingSessionFile
          : canonicalSessionFile;
      const patch: Partial<SessionEntry> = {
        sessionId: stableSessionId,
        channel: CLAWLINE_SESSION_CHANNEL,
        chatType: "direct",
        displayName: label,
        label,
        sessionFile: stableSessionFile,
        lastChannel: CLAWLINE_SESSION_CHANNEL,
      };
      // Don't set lastTo on connect; only update it after an actual user message.
      store[sessionKey] = mergeSessionEntry(existing, patch);
    });
  } catch (err) {
    params.logger?.warn?.("[clawline] failed to update session store", err);
  }
}
