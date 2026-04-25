import os from "node:os";
import path from "node:path";
import { loadSessionStore, resolveStorePath, type OpenClawConfig } from "../runtime-api.js";

const DEFAULT_AGENT_ID = "main";
const DEFAULT_MAIN_KEY = "main";
const VALID_AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_AGENT_ID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;
const SAFE_SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export type ClawlineSessionEntry = ReturnType<typeof loadSessionStore>[string];

function normalizeLowercaseStringOrEmpty(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizeMainKey(value: string | undefined | null): string {
  return normalizeLowercaseStringOrEmpty(value) || DEFAULT_MAIN_KEY;
}

function normalizeAgentId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return DEFAULT_AGENT_ID;
  }
  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  if (VALID_AGENT_ID_RE.test(trimmed)) {
    return normalized;
  }
  return (
    normalized
      .replace(INVALID_AGENT_ID_CHARS_RE, "-")
      .replace(LEADING_DASH_RE, "")
      .replace(TRAILING_DASH_RE, "")
      .slice(0, 64) || DEFAULT_AGENT_ID
  );
}

function resolveRequiredHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const override = env.OPENCLAW_HOME?.trim();
  const home = override || homedir();
  if (!home.trim()) {
    throw new Error("Unable to resolve home directory");
  }
  return home;
}

function validateSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!SAFE_SESSION_ID_RE.test(trimmed)) {
    throw new Error(`Invalid session ID: ${sessionId}`);
  }
  return trimmed;
}

export function resolveClawlineDefaultAgentWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const home = resolveRequiredHomeDir(env, homedir);
  const profile = env.OPENCLAW_PROFILE?.trim();
  if (profile && normalizeLowercaseStringOrEmpty(profile) !== "default") {
    return path.join(home, ".openclaw", `workspace-${profile}`);
  }
  return path.join(home, ".openclaw", "workspace");
}

export const CLAWLINE_DEFAULT_AGENT_WORKSPACE_DIR = resolveClawlineDefaultAgentWorkspaceDir();

export function resolveClawlineMainSessionKey(cfg?: OpenClawConfig): string {
  if (cfg?.session?.scope === "global") {
    return "global";
  }
  const agents = cfg?.agents?.list ?? [];
  const defaultAgentId =
    agents.find((agent) => agent?.default)?.id ?? agents[0]?.id ?? DEFAULT_AGENT_ID;
  return `agent:${normalizeAgentId(defaultAgentId)}:${normalizeMainKey(cfg?.session?.mainKey)}`;
}

export function isClawlineCronRunSessionKey(sessionKey: string | undefined | null): boolean {
  const raw = normalizeLowercaseStringOrEmpty(sessionKey);
  if (!raw) {
    return false;
  }
  const parts = raw.split(":").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "agent") {
    return false;
  }
  return /^cron:[^:]+:run:[^:]+$/.test(parts.slice(2).join(":"));
}

export function resolveClawlineSessionTranscriptsDirForAgent(agentId?: string): string {
  return path.dirname(resolveStorePath(undefined, { agentId: normalizeAgentId(agentId) }));
}

export function resolveClawlineSessionTranscriptPath(
  sessionId: string,
  agentId?: string,
  topicId?: string | number,
): string {
  const safeSessionId = validateSessionId(sessionId);
  const safeTopicId =
    typeof topicId === "string"
      ? encodeURIComponent(topicId)
      : typeof topicId === "number"
        ? String(topicId)
        : undefined;
  const fileName =
    safeTopicId !== undefined
      ? `${safeSessionId}-topic-${safeTopicId}.jsonl`
      : `${safeSessionId}.jsonl`;
  return path.join(resolveClawlineSessionTranscriptsDirForAgent(agentId), fileName);
}

// Clawline only patches flat session metadata fields here, so a shallow merge
// preserves unrelated entry state without pulling in the broader core helper.
export function mergeClawlineSessionEntry(
  existing: ClawlineSessionEntry | undefined,
  patch: Partial<ClawlineSessionEntry>,
): ClawlineSessionEntry {
  const updatedAt = Math.max(existing?.updatedAt ?? 0, patch.updatedAt ?? 0, Date.now());
  return {
    ...existing,
    ...patch,
    updatedAt,
  } as ClawlineSessionEntry;
}
