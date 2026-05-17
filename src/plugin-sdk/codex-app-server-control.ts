import fs from "node:fs/promises";

export type CodexAppServerFastModeStatus =
  | { available: true; enabled: boolean; serviceTier?: string }
  | { available: false; reason: string };

type CodexAppServerBindingReadResult =
  | { ok: true; binding?: CodexAppServerBindingPayload }
  | { ok: false; reason: string };

type CodexAppServerBindingPayload = {
  schemaVersion?: unknown;
  threadId?: unknown;
  sessionFile?: unknown;
  serviceTier?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  [key: string]: unknown;
};

function resolveCodexAppServerBindingPath(sessionFile: string): string {
  return `${sessionFile}.codex-app-server.json`;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function normalizeCodexServiceTier(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "fast" || normalized === "priority") {
    return "priority";
  }
  if (normalized === "flex") {
    return "flex";
  }
  return trimmed;
}

function isCodexFastServiceTier(value: unknown): value is "priority" {
  return normalizeCodexServiceTier(value) === "priority";
}

function isCodexFastControllableServiceTier(value: string | undefined): boolean {
  return value === undefined || value === "priority" || value === "flex";
}

async function readCodexAppServerBindingPayload(
  sessionFile: string,
): Promise<CodexAppServerBindingReadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(resolveCodexAppServerBindingPath(sessionFile), "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return { ok: true, binding: undefined };
    }
    return { ok: false, reason: "codex_app_server_binding_unreadable" };
  }
  let parsed: CodexAppServerBindingPayload;
  try {
    parsed = JSON.parse(raw) as CodexAppServerBindingPayload;
  } catch {
    return { ok: false, reason: "codex_app_server_binding_unreadable" };
  }
  if (parsed.schemaVersion !== 1 || typeof parsed.threadId !== "string" || !parsed.threadId) {
    return { ok: true, binding: undefined };
  }
  return { ok: true, binding: parsed };
}

export async function readCodexAppServerFastMode(params: {
  sessionFile: string;
}): Promise<CodexAppServerFastModeStatus> {
  const result = await readCodexAppServerBindingPayload(params.sessionFile);
  if (!result.ok) {
    return { available: false, reason: result.reason };
  }
  if (!result.binding) {
    return { available: false, reason: "codex_thread_not_attached" };
  }
  const serviceTier = normalizeCodexServiceTier(result.binding.serviceTier);
  if (!isCodexFastControllableServiceTier(serviceTier)) {
    return { available: false, reason: "codex_service_tier_not_supported_by_fast_control" };
  }
  return {
    available: true,
    enabled: isCodexFastServiceTier(serviceTier),
    serviceTier,
  };
}

export async function setCodexAppServerFastMode(params: {
  sessionFile: string;
  enabled: boolean;
}): Promise<void> {
  const result = await readCodexAppServerBindingPayload(params.sessionFile);
  if (!result.ok) {
    throw new Error("Codex app-server binding is not readable.");
  }
  if (!result.binding) {
    throw new Error("No Codex thread is attached to this OpenClaw session yet.");
  }
  const currentServiceTier = normalizeCodexServiceTier(result.binding.serviceTier);
  if (!isCodexFastControllableServiceTier(currentServiceTier)) {
    throw new Error("Codex service tier is not supported by Fast control.");
  }
  const now = new Date().toISOString();
  const payload: CodexAppServerBindingPayload = {
    ...result.binding,
    schemaVersion: 1,
    sessionFile: params.sessionFile,
    serviceTier: params.enabled ? "priority" : "flex",
    createdAt: typeof result.binding.createdAt === "string" ? result.binding.createdAt : now,
    updatedAt: now,
  };
  await fs.writeFile(
    resolveCodexAppServerBindingPath(params.sessionFile),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
}
