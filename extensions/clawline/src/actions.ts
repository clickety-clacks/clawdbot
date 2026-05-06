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
const INTERACTIVE_HTML_MIME = "application/vnd.clawline.interactive-html+json";
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

function isStrictBase64(input: string): boolean {
  const compact = input.replace(/\s+/g, "");
  if (!compact || compact.length % 4 !== 0) {
    return false;
  }
  if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(compact)) {
    return false;
  }
  try {
    const roundTrip = Buffer.from(compact, "base64").toString("base64");
    const stripPadding = (value: string) => value.replace(/=+$/g, "");
    return stripPadding(roundTrip) === stripPadding(compact);
  } catch {
    return false;
  }
}

function decodeBase64OrDataUrl(value: string, errorLabel: string): string {
  const trimmed = value.trim();
  let base64Payload = trimmed;
  if (trimmed.startsWith("data:")) {
    const commaIndex = trimmed.indexOf(",");
    if (commaIndex < 0) {
      throw new Error(`${errorLabel} is not valid base64 JSON`);
    }
    const metadata = trimmed.slice(5, commaIndex);
    if (!/;base64(?:;|$)/i.test(metadata)) {
      throw new Error(`${errorLabel} is not valid base64 JSON`);
    }
    base64Payload = trimmed.slice(commaIndex + 1);
  }
  if (!isStrictBase64(base64Payload)) {
    throw new Error(`${errorLabel} is not valid base64 JSON`);
  }
  return Buffer.from(base64Payload.replace(/\s+/g, ""), "base64").toString("utf8");
}

function isInteractiveHTMLDescriptor(value: unknown): value is { version: unknown; html: unknown } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function metaTags(html: string): string[] {
  return html.match(/<meta\b[^>]*>/gi) ?? [];
}

function hasMetaAttribute(tag: string, attribute: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `\\b${attribute}\\s*=\\s*(?:"${escaped}"|'${escaped}'|${escaped})(?:\\s|/?>)`,
    "i",
  ).test(tag);
}

function hasViewportMeta(html: string): boolean {
  return metaTags(html).some((tag) => hasMetaAttribute(tag, "name", "viewport"));
}

function hasCustomCSPMeta(html: string): boolean {
  return metaTags(html).some((tag) =>
    hasMetaAttribute(tag, "http-equiv", "Content-Security-Policy"),
  );
}

function validateInteractiveHTMLAttachment(buffer: string): void {
  let descriptor: unknown;
  try {
    descriptor = JSON.parse(
      decodeBase64OrDataUrl(buffer, "Clawline interactive HTML descriptor"),
    ) as unknown;
  } catch {
    throw new Error("Clawline interactive HTML descriptor is not valid base64 JSON");
  }

  if (!isInteractiveHTMLDescriptor(descriptor)) {
    throw new Error("Clawline interactive HTML descriptor must be a JSON object");
  }
  if (descriptor.version !== 1) {
    throw new Error("Clawline interactive HTML descriptor requires version 1");
  }
  const html = typeof descriptor.html === "string" ? descriptor.html.trim() : "";
  if (!html) {
    throw new Error("Clawline interactive HTML descriptor requires non-empty html");
  }
  if (!hasViewportMeta(html)) {
    throw new Error("Clawline interactive HTML descriptor requires viewport meta tag");
  }
  if (hasCustomCSPMeta(html)) {
    throw new Error("Clawline interactive HTML descriptor must not include custom CSP");
  }
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
  return {
    destination: { address },
    ...(title ? { title } : {}),
  };
}

function buildTerminalBubbleDescriptorRequest(request: TerminalBubbleRequest): string {
  const terminalSessionId = `term_${randomUUID().replace(/-/g, "")}`;
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
    descriptor = JSON.parse(
      decodeBase64OrDataUrl(buffer, "Clawline terminal bubble descriptor"),
    ) as {
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
    if (params.mimeType === INTERACTIVE_HTML_MIME) {
      validateInteractiveHTMLAttachment(explicitBuffer);
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
