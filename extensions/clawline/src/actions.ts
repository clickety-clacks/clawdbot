import type { AgentToolResult, OpenClawConfig } from "openclaw/plugin-sdk";
import { jsonResult } from "openclaw/plugin-sdk";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  OpenClawConfig,
} from "openclaw/plugin-sdk";
import BetterSqlite3 from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { jsonResult, sendClawlineOutboundMessage } from "openclaw/plugin-sdk";

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
}): Promise<{ ok: boolean; messages: ParsedMessage[]; error?: string }> {
  const { cfg, limit = 20 } = params;
  const dbPath = resolveClawlineDbPath(cfg);

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
    const actions: ChannelMessageActionName[] = ["send", "sendAttachment", "read", "list-users"];
    return actions;
  },
  supportsAction: ({ action }) =>
    action === "sendAttachment" || action === "read" || action === "list-users",

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
      const limit =
        typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.floor(params.limit)
          : 20;

      const result = await readClawlineMessages({ cfg, userId, limit, channelType });
      return jsonResult(result);
    }

    if (action === "list-users") {
      const result = await listClawlineUsers({ cfg });
      return jsonResult(result);
    }

    throw new Error(`Action ${action} is not supported for Clawline.`);
  },
};
