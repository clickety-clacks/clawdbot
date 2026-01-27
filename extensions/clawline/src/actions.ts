import type { AgentToolResult, ClawdbotConfig } from "clawdbot/plugin-sdk";
import { jsonResult } from "clawdbot/plugin-sdk";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
} from "../../../src/channels/plugins/types.js";
import BetterSqlite3 from "better-sqlite3";
import path from "node:path";
import os from "node:os";

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

function resolveClawlineDbPath(cfg: ClawdbotConfig): string {
  const clawlineStatePath = cfg.clawline?.statePath;
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

async function readClawlineMessages(params: {
  cfg: ClawdbotConfig;
  userId?: string;
  limit?: number;
  channelType?: string;
}): Promise<{ ok: boolean; messages: ParsedMessage[]; error?: string }> {
  const { cfg, limit = 20 } = params;
  const dbPath = resolveClawlineDbPath(cfg);

  let db: BetterSqlite3.Database | null = null;
  try {
    db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });

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
    const rows = stmt.all(...queryParams) as EventRow[];

    // Parse and filter messages
    let messages = rows.map(parseEventPayload);

    // Filter by channelType if specified
    if (params.channelType) {
      messages = messages.filter((m) => m.channelType === params.channelType);
    }

    // Filter to only actual messages (user_message, server_message)
    messages = messages.filter((m) => m.type === "user_message" || m.type === "server_message");

    // Reverse to get chronological order
    messages.reverse();

    return { ok: true, messages };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("SQLITE_CANTOPEN") || message.includes("no such file")) {
      return { ok: false, messages: [], error: "Clawline database not found. Is Clawline running?" };
    }
    return { ok: false, messages: [], error: message };
  } finally {
    db?.close();
  }
}

async function listClawlineUsers(params: {
  cfg: ClawdbotConfig;
}): Promise<{ ok: boolean; users: { userId: string; messageCount: number }[]; error?: string }> {
  const { cfg } = params;
  const dbPath = resolveClawlineDbPath(cfg);

  let db: BetterSqlite3.Database | null = null;
  try {
    db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });

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
    if (!cfg.clawline?.enabled) return [];
    const actions: ChannelMessageActionName[] = ["send", "read", "list-users"];
    return actions;
  },
  supportsAction: ({ action }) => action === "read" || action === "list-users",

  handleAction: async ({ action, params, cfg }): Promise<AgentToolResult<unknown>> => {
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
