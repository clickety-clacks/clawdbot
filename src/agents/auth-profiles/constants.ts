type AuthProfilesLogger = {
  subsystem: string;
  trace: (message: string, meta?: Record<string, unknown>) => void;
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  fatal: (message: string, meta?: Record<string, unknown>) => void;
  raw: (message: string) => void;
  child: (name: string) => AuthProfilesLogger;
};

const noop = () => {};

const createFallbackLogger = (subsystem: string): AuthProfilesLogger => ({
  subsystem,
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  fatal: noop,
  raw: noop,
  child: (name) => createFallbackLogger(`${subsystem}/${name}`),
});

let cachedLogger: AuthProfilesLogger | null = null;

export function getAuthProfilesLogger(): AuthProfilesLogger {
  if (cachedLogger) return cachedLogger;
  const globalFactory = (globalThis as {
    __clawdbotCreateSubsystemLogger?: (subsystem: string) => AuthProfilesLogger;
  }).__clawdbotCreateSubsystemLogger;
  if (typeof globalFactory === "function") {
    cachedLogger = globalFactory("agents/auth-profiles");
    return cachedLogger;
  }
  cachedLogger = createFallbackLogger("agents/auth-profiles");
  return cachedLogger;
}

export const AUTH_STORE_VERSION = 1;
export const AUTH_PROFILE_FILENAME = "auth-profiles.json";
export const LEGACY_AUTH_FILENAME = "auth.json";

export const CLAUDE_CLI_PROFILE_ID = "anthropic:claude-cli";
export const CODEX_CLI_PROFILE_ID = "openai-codex:codex-cli";
export const QWEN_CLI_PROFILE_ID = "qwen-portal:qwen-cli";
export const MINIMAX_CLI_PROFILE_ID = "minimax-portal:minimax-cli";

export const AUTH_STORE_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 30_000,
} as const;

export const EXTERNAL_CLI_SYNC_TTL_MS = 15 * 60 * 1000;
export const EXTERNAL_CLI_NEAR_EXPIRY_MS = 10 * 60 * 1000;
