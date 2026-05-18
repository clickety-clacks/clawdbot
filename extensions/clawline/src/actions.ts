import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import BetterSqlite3 from "better-sqlite3";
import { jsonResult } from "openclaw/plugin-sdk/agent-runtime";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import type { NormalizedAttachment } from "./runtime/domain.js";
import { sendClawlineOutboundMessage } from "./runtime/outbound.js";

const TERMINAL_SESSION_MIME = "application/vnd.clawline.terminal-session+json";
const TERMINAL_BUBBLE_CAPABILITIES = {
  interactive: true,
  supportsBinaryFrames: true,
  supportsResize: true,
  supportsDetach: true,
} as const;

type TerminalBubbleRequest = {
  destination: {
    address: string;
  };
  terminalSessionId?: string;
  title?: string;
};

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

function resolveClawlineDbPath(cfg: OpenClawConfig): string {
  const clawlineStatePath = cfg.channels?.clawline?.statePath;
  if (clawlineStatePath) {
    return path.join(clawlineStatePath, "clawline.sqlite");
  }
  // Default path
  const homeDir = os.homedir();
  return path.join(homeDir, ".openclaw", "clawline", "clawline.sqlite");
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

function decodeBase64OrDataUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("data:")) {
    const commaIndex = trimmed.indexOf(",");
    if (commaIndex < 0) {
      throw new Error("Clawline terminal bubble descriptor is not valid base64 JSON");
    }
    const metadata = trimmed.slice(5, commaIndex);
    if (!/;base64(?:;|$)/i.test(metadata)) {
      throw new Error("Clawline terminal bubble descriptor is not valid base64 JSON");
    }
    return Buffer.from(trimmed.slice(commaIndex + 1), "base64").toString("utf8");
  }
  return Buffer.from(trimmed, "base64").toString("utf8");
}

function readTerminalBubbleRequest(params: Record<string, unknown>): TerminalBubbleRequest | null {
  const rawDestination = params.destination;
  if (rawDestination === undefined) {
    return null;
  }
  if (!rawDestination || typeof rawDestination !== "object") {
    throw new Error("Clawline terminal bubble request requires destination.address");
  }
  const address =
    typeof (rawDestination as { address?: unknown }).address === "string"
      ? (rawDestination as { address: string }).address.trim()
      : "";
  if (!address) {
    throw new Error("Clawline terminal bubble request requires destination.address");
  }
  const title = readStringParam(params, ["title"]);
  const terminalSessionId = readStringParam(params, ["terminalSessionId"]);
  return {
    destination: { address },
    ...(terminalSessionId ? { terminalSessionId } : {}),
    ...(title ? { title } : {}),
  };
}

function buildTerminalBubbleDescriptorRequest(request: TerminalBubbleRequest): string {
  const terminalSessionId = request.terminalSessionId ?? `term_${randomUUID().replace(/-/g, "")}`;
  const descriptor = {
    version: 2,
    terminalSessionId,
    title: request.title ?? request.destination.address,
    destination: request.destination,
    provider: {
      wsPath: "/ws/terminal",
    },
    capabilities: TERMINAL_BUBBLE_CAPABILITIES,
    auth: {
      mode: "chat_token",
    },
  };
  return Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64");
}

function validateTerminalBubbleAttachment(buffer: string): void {
  let descriptor: {
    version?: unknown;
    terminalSessionId?: unknown;
    destination?: { address?: unknown } | null;
  };
  try {
    descriptor = JSON.parse(decodeBase64OrDataUrl(buffer)) as {
      version?: unknown;
      terminalSessionId?: unknown;
      destination?: { address?: unknown } | null;
    };
  } catch {
    throw new Error("Clawline terminal bubble descriptor is not valid base64 JSON");
  }

  const terminalSessionId =
    typeof descriptor.terminalSessionId === "string" ? descriptor.terminalSessionId.trim() : "";
  const version =
    typeof descriptor.version === "number" && Number.isFinite(descriptor.version)
      ? Math.floor(descriptor.version)
      : null;
  const destinationAddress =
    typeof descriptor.destination?.address === "string"
      ? descriptor.destination.address.trim()
      : "";

  if (!terminalSessionId) {
    throw new Error("Clawline terminal bubble descriptor requires terminalSessionId");
  }
  if (version !== 2 || !destinationAddress) {
    throw new Error("Clawline terminal bubbles now require version 2 with destination.address");
  }
}

function resolveSendAttachmentBuffer(params: {
  params: Record<string, unknown>;
  mimeType: string;
}): string {
  const explicitBuffer =
    typeof params.params.buffer === "string" ? params.params.buffer.trim() : "";
  if (params.mimeType !== TERMINAL_SESSION_MIME) {
    if (!explicitBuffer) {
      throw new Error("Clawline sendAttachment requires buffer (base64 or data: URL)");
    }
    return explicitBuffer;
  }

  const terminalRequest = readTerminalBubbleRequest(params.params);
  if (terminalRequest) {
    if (explicitBuffer) {
      throw new Error(
        "Clawline terminal bubble request cannot include both destination routing and a raw descriptor buffer",
      );
    }
    return buildTerminalBubbleDescriptorRequest(terminalRequest);
  }

  if (!explicitBuffer) {
    throw new Error("Clawline sendAttachment requires buffer (base64 or data: URL)");
  }
  validateTerminalBubbleAttachment(explicitBuffer);
  return explicitBuffer;
}

function summarizeOutboundResult(result: Awaited<ReturnType<typeof sendClawlineOutboundMessage>>) {
  // Never echo base64 attachment payloads back to the agent/tool output. They can be large and
  // can cause tool delivery to stall.
  const attachments = Array.isArray(result.attachments)
    ? result.attachments.map((attachment: NormalizedAttachment) => {
        switch (attachment.type) {
          case "asset":
            return { type: "asset", assetId: attachment.assetId };
          case "image":
            return {
              type: "image",
              mimeType: attachment.mimeType,
              assetId: attachment.assetId,
            };
          case "document":
            return { type: "document", mimeType: attachment.mimeType };
          default: {
            const exhaustiveCheck: never = attachment;
            throw new Error(
              `Unsupported Clawline outbound attachment: ${JSON.stringify(exhaustiveCheck)}`,
            );
          }
        }
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

  let db: import("better-sqlite3").Database | null = null;
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

    const targetLimit = Math.min(limit, 100);
    query += ` ORDER BY timestamp DESC LIMIT ? OFFSET ?`;

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

export const clawlineMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg }) => {
    if (!cfg.channels?.clawline?.enabled) {
      return null;
    }
    const actions: ChannelMessageActionName[] = ["send", "sendAttachment", "read"];
    return {
      actions,
      schema: {
        properties: {
          destination: Type.Optional(
            Type.Object({
              address: Type.String({
                description:
                  "For Clawline terminal bubbles, the per-bubble destination address, for example mike@eezo.",
              }),
            }),
          ),
          title: Type.Optional(
            Type.String({
              description:
                "Optional Clawline terminal bubble title. When omitted, the provider defaults it from destination.address.",
            }),
          ),
          terminalSessionId: Type.Optional(
            Type.String({
              description:
                "Optional Clawline terminal bubble tmux session identity/name. When omitted, the provider generates a fresh id.",
            }),
          ),
        },
      },
    };
  },
  supportsAction: ({ action }) => action === "sendAttachment" || action === "read",

  handleAction: async ({ action, params, cfg }): Promise<AgentToolResult<unknown>> => {
    if (action === "sendAttachment") {
      const to =
        (typeof params.target === "string" ? params.target : undefined) ??
        (typeof params.to === "string" ? params.to : undefined);
      if (!to?.trim()) {
        throw new Error("Clawline sendAttachment requires target/to");
      }
      const rawMimeType =
        (typeof params.contentType === "string" ? params.contentType : undefined) ??
        (typeof params.mimeType === "string" ? params.mimeType : undefined) ??
        "application/octet-stream";
      const mimeType = normalizeMimeType(rawMimeType);
      const buffer = resolveSendAttachmentBuffer({ params, mimeType });
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

    throw new Error(`Action ${action} is not supported for Clawline.`);
  },
};
