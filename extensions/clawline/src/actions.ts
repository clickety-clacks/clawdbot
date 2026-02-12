import type { AgentToolResult, OpenClawConfig } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import BetterSqlite3 from "better-sqlite3";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { jsonResult, sendClawlineOutboundMessage } from "openclaw/plugin-sdk";

const DEFAULT_CLAWLINE_PORT = 18800;
const STREAM_API_TIMEOUT_MS = 15_000;
const STREAM_DELETE_USER_ACTION = "delete_stream";

type EventRow = {
  id: string;
  userId: string;
  sequence: number;
  originatingDeviceId: string | null;
  payloadJson: string;
  payloadBytes: number;
  timestamp: number;
};

type ParsedMessage = {
  id: string;
  userId: string;
  sequence: number;
  timestamp: number;
  timestampIso: string;
  deviceId: string | null;
  type: string;
  content?: string;
  fromServer?: boolean;
  channelType?: string;
  sessionKey?: string;
};

type StreamApiCallResult =
  | {
      ok: true;
      status: number;
      body: Record<string, unknown>;
    }
  | {
      ok: false;
      status: number;
      error: {
        code: string;
        message: string;
      };
      body?: Record<string, unknown>;
    };

function resolveClawlineDbPath(cfg: OpenClawConfig): string {
  const clawlineStatePath = cfg.channels?.clawline?.statePath;
  if (clawlineStatePath) {
    return path.join(clawlineStatePath, "clawline.sqlite");
  }
  // Default path
  const homeDir = os.homedir();
  return path.join(homeDir, ".clawdbot", "clawline", "clawline.sqlite");
}

function parseEventPayload(row: EventRow): ParsedMessage {
  const base: ParsedMessage = {
    id: row.id,
    userId: row.userId,
    sequence: row.sequence,
    timestamp: row.timestamp,
    timestampIso: new Date(row.timestamp).toISOString(),
    deviceId: row.originatingDeviceId,
    type: "unknown",
  };

  try {
    const payload = JSON.parse(row.payloadJson);
    // Events have type="message" with role="user" or role="assistant"
    if (payload.type === "message") {
      const role = payload.role as string | undefined;
      const isFromUser = role === "user";
      return {
        ...base,
        type: isFromUser ? "user_message" : "server_message",
        content: payload.content ?? "",
        fromServer: !isFromUser,
        channelType: payload.channelType,
        sessionKey: typeof payload.sessionKey === "string" ? payload.sessionKey : undefined,
        deviceId: payload.deviceId ?? row.originatingDeviceId,
      };
    }
    return { ...base, type: payload.type ?? "unknown" };
  } catch {
    return base;
  }
}

function normalizeMimeType(value: string): string {
  // Drop any parameters ("; charset=utf-8") so provider-side exact matches work reliably.
  const head = value.split(";")[0] ?? "";
  return head.trim().toLowerCase();
}

function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([
    promise.finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    }),
    timeout,
  ]);
}

function readStringParam(params: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizeHttpHost(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || trimmed === "0.0.0.0" || trimmed === "::" || trimmed === "[::]") {
    return "127.0.0.1";
  }
  return trimmed.replace(/^\[|\]$/g, "");
}

function hostToUrlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function resolveClawlineApiBaseUrl(cfg: OpenClawConfig, params: Record<string, unknown>): string {
  const explicitBaseUrl = readStringParam(params, ["baseUrl", "apiBaseUrl", "gatewayUrl"]);
  if (explicitBaseUrl) {
    try {
      return new URL(explicitBaseUrl).origin;
    } catch {
      throw new Error("Clawline stream actions require an absolute baseUrl when provided");
    }
  }
  const bindAddress = normalizeHttpHost(cfg.channels?.clawline?.network?.bindAddress);
  const port = cfg.channels?.clawline?.port ?? DEFAULT_CLAWLINE_PORT;
  return `http://${hostToUrlHost(bindAddress)}:${port}`;
}

function toObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

async function parseJsonObject(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return toObject(parsed);
  } catch {
    return {};
  }
}

function parseStreamApiError(
  body: Record<string, unknown>,
  status: number,
): {
  code: string;
  message: string;
} {
  const rawError = body.error;
  if (rawError && typeof rawError === "object" && !Array.isArray(rawError)) {
    const parsed = rawError as Record<string, unknown>;
    const code = typeof parsed.code === "string" ? parsed.code : "stream_api_error";
    const message =
      typeof parsed.message === "string"
        ? parsed.message
        : `Clawline stream API request failed (${status})`;
    return { code, message };
  }
  return {
    code: "stream_api_error",
    message: `Clawline stream API request failed (${status})`,
  };
}

async function callStreamApi(params: {
  cfg: OpenClawConfig;
  actionParams: Record<string, unknown>;
  path: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  body?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
}): Promise<StreamApiCallResult> {
  const token = readStringParam(params.actionParams, ["token", "bearerToken", "authToken"]);
  if (!token) {
    throw new Error("Clawline stream actions require token (bearerToken/authToken also accepted)");
  }
  const baseUrl = resolveClawlineApiBaseUrl(params.cfg, params.actionParams);
  const requestUrl = new URL(params.path, `${baseUrl}/`);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...params.extraHeaders,
  };
  if (params.body) {
    headers["Content-Type"] = "application/json";
  }
  try {
    const response = await promiseWithTimeout(
      fetch(requestUrl, {
        method: params.method,
        headers,
        body: params.body ? JSON.stringify(params.body) : undefined,
      }),
      STREAM_API_TIMEOUT_MS,
      `Clawline ${params.method} ${params.path}`,
    );
    const body = await parseJsonObject(response);
    if (response.ok) {
      return { ok: true, status: response.status, body };
    }
    return {
      ok: false,
      status: response.status,
      error: parseStreamApiError(body, response.status),
      body,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 0,
      error: { code: "stream_api_unreachable", message },
    };
  }
}

function buildIdempotencyKey(actionParams: Record<string, unknown>): string {
  const existing = readStringParam(actionParams, ["idempotencyKey", "requestId"]);
  if (existing) {
    return existing;
  }
  return `req_${randomBytes(4).toString("hex")}`;
}

function summarizeOutboundResult(result: Awaited<ReturnType<typeof sendClawlineOutboundMessage>>) {
  // Never echo base64 attachment payloads back to the agent/tool output. They can be large and
  // can cause tool delivery to stall.
  const attachments = Array.isArray(result.attachments)
    ? result.attachments.map((a: any) => {
        if (!a || typeof a !== "object") {
          return { type: "unknown" };
        }
        if (a.type === "asset") {
          return { type: "asset", assetId: a.assetId };
        }
        if (a.type === "image") {
          return { type: "image", mimeType: a.mimeType, assetId: a.assetId };
        }
        if (a.type === "document") {
          return { type: "document", mimeType: a.mimeType };
        }
        return { type: String(a.type ?? "unknown") };
      })
    : undefined;

  return {
    ok: true,
    messageId: result.messageId,
    userId: result.userId,
    deviceId: result.deviceId,
    assetIds: result.assetIds,
    attachmentCount: Array.isArray(result.attachments) ? result.attachments.length : 0,
    attachments,
  };
}

async function readClawlineMessages(params: {
  cfg: OpenClawConfig;
  userId?: string;
  limit?: number;
  channelType?: string;
  sessionKey?: string;
}): Promise<{ ok: boolean; messages: ParsedMessage[]; error?: string }> {
  const { cfg, limit = 20 } = params;
  const dbPath = resolveClawlineDbPath(cfg);
  const normalizedSessionKey = params.sessionKey?.trim().toLowerCase();

  let db: BetterSqlite3.Database | null = null;
  try {
    db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true, timeout: 5000 });

    // Query recent events (messages are stored as events)
    let query = `
      SELECT id, userId, sequence, originatingDeviceId, payloadJson, payloadBytes, timestamp
      FROM events
      WHERE 1=1
    `;
    const queryParams: (string | number)[] = [];

    if (params.userId) {
      query += ` AND userId = ?`;
      queryParams.push(params.userId);
    }

    query += ` ORDER BY timestamp DESC LIMIT ?`;
    queryParams.push(Math.min(limit, 100)); // Cap at 100

    const stmt = db.prepare(query);
    const messages: ParsedMessage[] = [];
    const batchSize = 100;
    let offset = 0;
    const maxRowsToScan = Math.max(targetLimit * 20, 500);

    while (messages.length < targetLimit) {
      const rows = stmt.all(...queryParams, batchSize, offset) as EventRow[];
      if (rows.length === 0) {
        break;
      }
      offset += rows.length;
      for (const row of rows) {
        const parsed = parseEventPayload(row);
        if (params.channelType && parsed.channelType !== params.channelType) {
          continue;
        }
        if (normalizedSessionKey && parsed.sessionKey?.toLowerCase() !== normalizedSessionKey) {
          continue;
        }
        if (parsed.type !== "user_message" && parsed.type !== "server_message") {
          continue;
        }
        messages.push(parsed);
        if (messages.length >= targetLimit) {
          break;
        }
      }
      if (offset >= maxRowsToScan) {
        break;
      }
    }

    // Filter to only actual messages (user_message, server_message)
    messages = messages.filter((m) => m.type === "user_message" || m.type === "server_message");

    // Reverse to get chronological order
    messages.reverse();

    return { ok: true, messages };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("SQLITE_CANTOPEN") || message.includes("no such file")) {
      return {
        ok: false,
        messages: [],
        error: "Clawline database not found. Is Clawline running?",
      };
    }
    return { ok: false, messages: [], error: message };
  } finally {
    db?.close();
  }
}

async function listClawlineUsers(params: {
  cfg: OpenClawConfig;
}): Promise<{ ok: boolean; users: { userId: string; messageCount: number }[]; error?: string }> {
  const { cfg } = params;
  const dbPath = resolveClawlineDbPath(cfg);

  let db: BetterSqlite3.Database | null = null;
  try {
    db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true, timeout: 5000 });

    const stmt = db.prepare(`
      SELECT userId, COUNT(*) as messageCount
      FROM events
      GROUP BY userId
      ORDER BY MAX(timestamp) DESC
    `);
    const rows = stmt.all() as { userId: string; messageCount: number }[];

    return { ok: true, users: rows };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, users: [], error: message };
  } finally {
    db?.close();
  }
}

export const clawlineMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    if (!cfg.channels?.clawline?.enabled) {
      return [];
    }
    const actions: ChannelMessageActionName[] = [
      "send",
      "sendAttachment",
      "read",
      "list-users",
      "channel-list",
      "channel-create",
      "channel-edit",
      "channel-delete",
    ];
    return actions;
  },
  supportsAction: ({ action }) =>
    action === "sendAttachment" ||
    action === "read" ||
    action === "list-users" ||
    action === "channel-list" ||
    action === "channel-create" ||
    action === "channel-edit" ||
    action === "channel-delete",

  handleAction: async ({ action, params, cfg }): Promise<AgentToolResult<unknown>> => {
    if (action === "sendAttachment") {
      const to =
        (typeof params.target === "string" ? params.target : undefined) ??
        (typeof params.to === "string" ? params.to : undefined);
      if (!to?.trim()) {
        throw new Error("Clawline sendAttachment requires target/to");
      }
      const buffer = typeof params.buffer === "string" ? params.buffer.trim() : "";
      if (!buffer) {
        throw new Error("Clawline sendAttachment requires buffer (base64 or data: URL)");
      }
      const rawMimeType =
        (typeof params.contentType === "string" ? params.contentType : undefined) ??
        (typeof params.mimeType === "string" ? params.mimeType : undefined) ??
        "application/octet-stream";
      const mimeType = normalizeMimeType(rawMimeType);
      const caption =
        (typeof params.caption === "string" ? params.caption : undefined) ??
        (typeof params.message === "string" ? params.message : undefined) ??
        "";
      const result = await promiseWithTimeout(
        sendClawlineOutboundMessage({
          target: to.trim(),
          text: caption,
          attachments: [{ data: buffer, mimeType }],
        }),
        15_000,
        "Clawline sendAttachment",
      );
      return jsonResult(summarizeOutboundResult(result));
    }

    if (action === "read") {
      // Accept both userId param and to param (standard message tool target)
      const userId =
        (typeof params.userId === "string" ? params.userId : undefined) ??
        (typeof params.to === "string" ? params.to : undefined);
      const channelType = typeof params.channelType === "string" ? params.channelType : undefined;
      const sessionKey = readStringParam(params, ["sessionKey", "channelId"]);
      const limit =
        typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.floor(params.limit)
          : 20;

      const result = await readClawlineMessages({ cfg, userId, limit, channelType, sessionKey });
      return jsonResult(result);
    }

    if (action === "list-users") {
      const result = await listClawlineUsers({ cfg });
      return jsonResult(result);
    }

    if (action === "channel-list") {
      const result = await callStreamApi({
        cfg,
        actionParams: params,
        method: "GET",
        path: "/api/streams",
      });
      return jsonResult(result.ok ? { ok: true, status: result.status, ...result.body } : result);
    }

    if (action === "channel-create") {
      const displayName = readStringParam(params, ["displayName", "name", "title"]);
      if (!displayName) {
        throw new Error("Clawline channel-create requires displayName (or name/title)");
      }
      const idempotencyKey = buildIdempotencyKey(params);
      const result = await callStreamApi({
        cfg,
        actionParams: params,
        method: "POST",
        path: "/api/streams",
        body: { displayName, idempotencyKey },
      });
      return jsonResult(
        result.ok
          ? { ok: true, status: result.status, idempotencyKey, ...result.body }
          : { ...result, idempotencyKey },
      );
    }

    if (action === "channel-edit") {
      const sessionKey = readStringParam(params, ["channelId", "sessionKey", "to"]);
      if (!sessionKey) {
        throw new Error("Clawline channel-edit requires channelId/sessionKey");
      }
      const displayName = readStringParam(params, ["displayName", "name", "title"]);
      if (!displayName) {
        throw new Error("Clawline channel-edit requires displayName (or name/title)");
      }
      const result = await callStreamApi({
        cfg,
        actionParams: params,
        method: "PATCH",
        path: `/api/streams/${encodeURIComponent(sessionKey)}`,
        body: { displayName },
      });
      return jsonResult(result.ok ? { ok: true, status: result.status, ...result.body } : result);
    }

    if (action === "channel-delete") {
      const sessionKey = readStringParam(params, ["channelId", "sessionKey", "to"]);
      if (!sessionKey) {
        throw new Error("Clawline channel-delete requires channelId/sessionKey");
      }
      const idempotencyKey = buildIdempotencyKey(params);
      const result = await callStreamApi({
        cfg,
        actionParams: params,
        method: "DELETE",
        path: `/api/streams/${encodeURIComponent(sessionKey)}`,
        body: { idempotencyKey },
        extraHeaders: {
          "x-clawline-user-action": STREAM_DELETE_USER_ACTION,
        },
      });
      return jsonResult(
        result.ok
          ? { ok: true, status: result.status, idempotencyKey, ...result.body }
          : { ...result, idempotencyKey },
      );
    }

    throw new Error(`Action ${action} is not supported for Clawline.`);
  },
};
