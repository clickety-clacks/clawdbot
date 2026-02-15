import type { Database as SqliteDatabase, Statement as SqliteStatement } from "better-sqlite3";
import type { Stats } from "node:fs";
import BetterSqlite3 from "better-sqlite3";
import jwt from "jsonwebtoken";
import { execFile as execFileCb } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { watch, type FSWatcher, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type Dispatcher } from "undici";
import WebSocket, { WebSocketServer } from "ws";
import type { ResponsePrefixContext } from "../auto-reply/reply/response-prefix-template.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { ClawlineAdapterOverrides } from "./config.js";
import type {
  AllowlistEntry,
  AllowlistFile,
  DeviceInfo,
  NormalizedAttachment,
  PendingEntry,
  PendingFile,
  ProviderConfig,
  ProviderOptions,
  ProviderServer,
  Logger,
  ClawlineOutboundAttachmentInput,
  ClawlineOutboundSendParams,
  ClawlineOutboundSendResult,
  StreamSession,
  StreamSessionKind,
  StreamSnapshotServerMessage,
  StreamCreatedServerMessage,
  StreamUpdatedServerMessage,
  StreamDeletedServerMessage,
} from "./domain.js";
import {
  resolveEffectiveMessagesConfig,
  resolveHumanDelayConfig,
  resolveIdentityName,
} from "../agents/identity.js";
import { type AnnounceQueueItem, enqueueAnnounce } from "../agents/subagent-announce-queue.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../agents/workspace.js";
import { dispatchReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { getFollowupQueueDepth, resolveQueueSettings } from "../auto-reply/reply/queue.js";
import { createReplyDispatcherWithTyping } from "../auto-reply/reply/reply-dispatcher.js";
import { extractShortModelName } from "../auto-reply/reply/response-prefix-template.js";
import { recordInboundSession } from "../channels/session.js";
import { resolveAgentIdFromSessionKey, resolveSessionTranscriptPath } from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import {
  createPinnedDispatcher,
  resolvePinnedHostname,
  closeDispatcher,
  type PinnedHostname,
} from "../infra/net/ssrf.js";
import { peekSystemEvents } from "../infra/system-events.js";
import { rawDataToString } from "../infra/ws.js";
import { mediaKindFromMime, maxBytesForKind } from "../media/constants.js";
import { hasAlphaChannel, optimizeImageToPng } from "../media/image-ops.js";
import { detectMime } from "../media/mime.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/resolve-route.js";
import { optimizeImageToJpeg } from "../web/media.js";
import { clawlineAttachmentsToImages } from "./attachments.js";
import { ClientMessageError, HttpError } from "./errors.js";
import { createAssetHandlers } from "./http-assets.js";
import { createPerUserTaskQueue } from "./per-user-task-queue.js";
import { SlidingWindowRateLimiter } from "./rate-limiter.js";
import { ClawlineDeliveryTarget } from "./routing.js";
import { recordClawlineSessionActivity } from "./session-store.js";
import { deepMerge } from "./utils/deep-merge.js";

export const PROTOCOL_VERSION = 1;

const execFile = promisify(execFileCb);

type TerminalTmuxBackend = {
  execTmux(
    args: string[],
    options: { timeout: number; maxBuffer: number },
  ): Promise<{
    // oxlint-disable-next-line typescript/no-explicit-any
    stdout: any;
  }>;
  spawnAttachPty(params: { sessionName: string; cols: number; rows: number }): Promise<{
    // oxlint-disable-next-line typescript/no-explicit-any
    pty: any;
  }>;
};

function buildSshBaseArgs(cfg: ProviderConfig["terminal"]["tmux"]["ssh"]): string[] {
  const args: string[] = [];
  if (cfg.port && Number.isFinite(cfg.port)) {
    args.push("-p", String(cfg.port));
  }
  const identityFile = typeof cfg.identityFile === "string" ? cfg.identityFile.trim() : "";
  if (identityFile) {
    args.push("-i", identityFile, "-o", "IdentitiesOnly=yes");
  }
  const knownHostsFile = typeof cfg.knownHostsFile === "string" ? cfg.knownHostsFile.trim() : "";
  if (knownHostsFile) {
    args.push("-o", `UserKnownHostsFile=${knownHostsFile}`);
  }
  const strict =
    typeof cfg.strictHostKeyChecking === "string" ? cfg.strictHostKeyChecking.trim() : "";
  if (strict) {
    args.push("-o", `StrictHostKeyChecking=${strict}`);
  }
  // Prevent interactive prompts.
  args.push("-o", "BatchMode=yes");
  // Keep SSH failure modes predictable.
  args.push("-o", "ConnectTimeout=5");

  if (Array.isArray(cfg.extraArgs) && cfg.extraArgs.length > 0) {
    for (const item of cfg.extraArgs) {
      if (typeof item === "string" && item.trim().length > 0) {
        args.push(item);
      }
    }
  }
  return args;
}

function createTerminalTmuxBackend(config: ProviderConfig, logger: Logger): TerminalTmuxBackend {
  const tmuxMode = config.terminal?.tmux?.mode ?? "local";
  const sshCfg = config.terminal?.tmux?.ssh;
  const sshTarget = typeof sshCfg?.target === "string" ? sshCfg.target.trim() : "";
  const sshBaseArgs = sshCfg ? buildSshBaseArgs(sshCfg) : [];

  const isRemote = tmuxMode === "ssh";
  if (isRemote && !sshTarget) {
    logger.warn?.(
      "[clawline:terminal] tmux remote mode enabled but ssh target is empty; falling back to local",
    );
  }

  const useRemote = isRemote && sshTarget.length > 0;

  return {
    async execTmux(args: string[], options: { timeout: number; maxBuffer: number }) {
      if (!useRemote) {
        return execFile("tmux", args, options);
      }
      return execFile("ssh", [...sshBaseArgs, sshTarget, "--", "tmux", ...args], options);
    },
    async spawnAttachPty(params: { sessionName: string; cols: number; rows: number }) {
      const ptyModule = (await import("@lydell/node-pty")) as unknown as {
        // oxlint-disable-next-line typescript/no-explicit-any
        spawn: (file: string, args: string[], options: any) => any;
      };
      if (!useRemote) {
        const pty = ptyModule.spawn("tmux", ["attach-session", "-t", params.sessionName], {
          name: "xterm-256color",
          cols: params.cols,
          rows: params.rows,
        });
        return { pty };
      }
      // Force a remote TTY so tmux attach behaves like a real client.
      const sshArgs = [
        "-tt",
        ...sshBaseArgs,
        sshTarget,
        "--",
        "tmux",
        "attach-session",
        "-t",
        params.sessionName,
      ];
      const pty = ptyModule.spawn("ssh", sshArgs, {
        name: "xterm-256color",
        cols: params.cols,
        rows: params.rows,
      });
      return { pty };
    },
  };
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_REGEX = /[\u0000-\u001F\u007F]/g;
const UUID_V4_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const SERVER_EVENT_ID_REGEX =
  /^s_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ASSET_ID_REGEX =
  /^a_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const INLINE_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/heic",
]);
const TERMINAL_SESSION_MIME = "application/vnd.clawline.terminal-session+json";
const INTERACTIVE_HTML_MIME = "application/vnd.clawline.interactive-html+json";
const INTERACTIVE_CALLBACK_MIME = "application/vnd.clawline.interactive-callback+json";
const CLIENT_FEATURE_TERMINAL_BUBBLES_V1 = "terminal_bubbles_v1";
const SERVER_FEATURE_SESSION_INFO = "session_info";
const INLINE_DOCUMENT_MIME_TYPES = new Set([TERMINAL_SESSION_MIME, INTERACTIVE_HTML_MIME]);
const SUPPORTED_CLIENT_FEATURES = new Set([CLIENT_FEATURE_TERMINAL_BUBBLES_V1]);
const MAX_INTERACTIVE_ACTION_CHARS = 128;
const MAX_INTERACTIVE_DATA_BYTES = 64 * 1024;
const MAX_ALERT_BODY_BYTES = 4 * 1024;
const MAX_MEDIA_REDIRECTS = 5;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const MEDIA_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_ALERT_SOURCE = "notify";
const EXEC_COMPLETION_ALERT_PROMPT =
  "These items completed. Execute the next task, or identify what is blocking.";
const USER_ID_MAX_LENGTH = 48;
const COMBINING_MARKS_REGEX = /[\u0300-\u036f]/g;
const WEBROOT_PREFIX = "/www";
const STREAM_DB_VERSION = 2;
const STREAM_SUFFIX_REGEX = /^s_[0-9a-f]{8}$/;
const STREAM_DISPLAY_NAME_FALLBACK = "Stream";
const STREAM_IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const STREAM_IDEMPOTENCY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const STREAM_OPERATION_CREATE = "create_stream";
const STREAM_OPERATION_DELETE = "delete_stream";
const MAX_STREAMS_BODY_BYTES = 16 * 1024;
const STREAM_SESSION_KEY_PATH_DECODE_PASSES = 4;

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  let bytes = 0;
  let result = "";
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) {
      break;
    }
    result += char;
    bytes += charBytes;
  }
  return result;
}

function safeJsonStringify(value: unknown): { json: string; bytes: number } {
  // JSON.stringify(undefined) returns undefined; normalize to "null" so we always have JSON.
  let json: string | undefined;
  try {
    json = JSON.stringify(value === undefined ? null : value) ?? "null";
  } catch {
    throw new ClientMessageError("invalid_message", "Invalid JSON payload");
  }
  const bytes = Buffer.byteLength(json, "utf8");
  return { json, bytes };
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? `${err.name}: ${err.message}`;
  }
  if (typeof err === "string") {
    return err;
  }
  try {
    const serialized = JSON.stringify(err);
    return serialized ?? String(err);
  } catch {
    return String(err);
  }
}

function parseClientFeatures(payload: unknown): Set<string> {
  const out = new Set<string>();
  const addValues = (value: unknown) => {
    if (!Array.isArray(value)) {
      return;
    }
    for (const item of value) {
      if (typeof item !== "string") {
        continue;
      }
      const normalized = item.trim().toLowerCase();
      if (!normalized || !SUPPORTED_CLIENT_FEATURES.has(normalized)) {
        continue;
      }
      out.add(normalized);
    }
  };
  if (!payload || typeof payload !== "object") {
    return out;
  }
  const record = payload as { clientFeatures?: unknown; client?: unknown };
  addValues(record.clientFeatures);
  if (record.client && typeof record.client === "object") {
    const clientRecord = record.client as { features?: unknown };
    addValues(clientRecord.features);
  }
  return out;
}

function normalizeMimeForComparison(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : null;
}

function isTerminalSessionDocumentAttachment(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const attachment = value as { type?: unknown; mimeType?: unknown };
  if (attachment.type !== "document") {
    return false;
  }
  return normalizeMimeForComparison(attachment.mimeType) === TERMINAL_SESSION_MIME;
}

function buildAuthResultFeatures(session: Session): string[] {
  const features = [SERVER_FEATURE_SESSION_INFO];
  if (session.clientFeatures.has(CLIENT_FEATURE_TERMINAL_BUBBLES_V1)) {
    features.push(CLIENT_FEATURE_TERMINAL_BUBBLES_V1);
  }
  return features;
}

function normalizePayloadForSession(
  session: Session,
  payload: ServerMessage,
  normalizedMainSessionKey: string,
): ServerMessage | null {
  const effectiveSessionKey = payload.sessionKey ?? session.sessionKey;
  if (effectiveSessionKey.toLowerCase() === normalizedMainSessionKey && !session.isAdmin) {
    return null;
  }
  let attachments = payload.attachments;
  if (
    Array.isArray(attachments) &&
    attachments.length > 0 &&
    !session.clientFeatures.has(CLIENT_FEATURE_TERMINAL_BUBBLES_V1)
  ) {
    const filtered = attachments.filter(
      (attachment) => !isTerminalSessionDocumentAttachment(attachment),
    );
    attachments = filtered.length > 0 ? filtered : undefined;
  }
  return {
    ...payload,
    sessionKey: effectiveSessionKey,
    attachments,
  };
}

function sanitizeLabel(label?: string): string | undefined {
  if (typeof label !== "string") {
    return undefined;
  }
  const stripped = label.replace(CONTROL_CHARS_REGEX, "").trim();
  if (!stripped) {
    return undefined;
  }
  return truncateUtf8(stripped, 64);
}

function sanitizeStreamDisplayName(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const stripped = value.replace(CONTROL_CHARS_REGEX, "").trim();
  if (!stripped) {
    return null;
  }
  if (Buffer.byteLength(stripped, "utf8") > maxBytes) {
    return null;
  }
  return stripped;
}

function sanitizeDeviceInfo(info: DeviceInfo): DeviceInfo {
  const sanitizeField = (value: string | undefined) => {
    if (typeof value !== "string") {
      return undefined;
    }
    const stripped = value.replace(CONTROL_CHARS_REGEX, "").trim();
    if (!stripped) {
      return undefined;
    }
    return truncateUtf8(stripped, 64);
  };
  return {
    platform: sanitizeField(info.platform) ?? "",
    model: sanitizeField(info.model) ?? "",
    osVersion: sanitizeField(info.osVersion),
    appVersion: sanitizeField(info.appVersion),
  };
}

function derivePeerId(entry: AllowlistEntry): string {
  const sources = [
    entry.bindingId?.trim(),
    entry.claimedName?.trim(),
    entry.deviceInfo.model?.trim(),
    entry.deviceInfo.platform?.trim(),
    entry.userId.trim(),
    entry.deviceId.trim(),
  ].filter((value): value is string => Boolean(value && value.length > 0));
  return sources[0] ?? entry.deviceId;
}

function normalizeUserIdFromClaimedName(claimedName?: string): string | null {
  if (!claimedName) {
    return null;
  }
  const ascii = claimedName.normalize("NFKD").replace(COMBINING_MARKS_REGEX, "");
  const lowered = ascii.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9]+/g, "_");
  const trimmed = replaced.replace(/^_+|_+$/g, "");
  if (!trimmed) {
    return null;
  }
  return trimmed.slice(0, USER_ID_MAX_LENGTH);
}

function sanitizeUserId(userId: string | undefined): string {
  return (userId ?? "").trim();
}

function normalizeAllowlistEntry(entry: AllowlistEntry) {
  const normalizedFromName = normalizeUserIdFromClaimedName(entry.claimedName);
  let nextUserId = sanitizeUserId(entry.userId);
  if (!nextUserId) {
    nextUserId = normalizedFromName ?? "";
  }
  if (!nextUserId) {
    nextUserId = generateUserId();
  }
  entry.userId = nextUserId;
  if (typeof entry.isAdmin !== "boolean") {
    entry.isAdmin = false;
  }
}

function normalizeAttachmentsInput(
  raw: unknown,
  mediaConfig: ProviderConfig["media"],
): { attachments: NormalizedAttachment[]; inlineBytes: number; assetIds: string[] } {
  if (raw === undefined) {
    return { attachments: [], inlineBytes: 0, assetIds: [] };
  }
  if (!Array.isArray(raw)) {
    throw new ClientMessageError("invalid_message", "attachments must be an array");
  }
  let inlineBytes = 0;
  const attachments: NormalizedAttachment[] = [];
  const assetIds: string[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      throw new ClientMessageError("invalid_message", "Invalid attachment");
    }
    const typed = entry;
    if (typed.type === "image") {
      if (typeof typed.mimeType !== "string" || typeof typed.data !== "string") {
        throw new ClientMessageError("invalid_message", "Invalid inline attachment");
      }
      const mime = typed.mimeType.toLowerCase();
      if (!INLINE_IMAGE_MIME_TYPES.has(mime)) {
        throw new ClientMessageError("invalid_message", "Unsupported image type");
      }
      let decoded: Buffer;
      try {
        decoded = Buffer.from(typed.data, "base64");
      } catch {
        throw new ClientMessageError("invalid_message", "Invalid base64 data");
      }
      if (decoded.length === 0) {
        throw new ClientMessageError("invalid_message", "Empty attachment data");
      }
      inlineBytes += decoded.length;
      attachments.push({ type: "image", mimeType: mime, data: typed.data });
    } else if (typed.type === "asset") {
      if (typeof typed.assetId !== "string" || !ASSET_ID_REGEX.test(typed.assetId)) {
        throw new ClientMessageError("invalid_message", "Invalid assetId");
      }
      attachments.push({ type: "asset", assetId: typed.assetId });
      assetIds.push(typed.assetId);
    } else {
      throw new ClientMessageError("invalid_message", "Unknown attachment type");
    }
  }
  if (inlineBytes > mediaConfig.maxInlineBytes) {
    throw new ClientMessageError("invalid_message", "Inline attachments exceed maxInlineBytes");
  }
  return { attachments, inlineBytes, assetIds };
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

function maybeEncodeJsonDocumentPayload(data: string, mimeType: string): string {
  if (mimeType !== TERMINAL_SESSION_MIME && mimeType !== INTERACTIVE_HTML_MIME) {
    return data;
  }
  if (isStrictBase64(data)) {
    return data.replace(/\s+/g, "");
  }
  const trimmed = data.trim();
  if (!trimmed) {
    return data;
  }
  const looksLikeJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  if (!looksLikeJson) {
    return data;
  }
  return Buffer.from(trimmed, "utf8").toString("base64");
}

function normalizeOutboundAttachmentData(input: ClawlineOutboundAttachmentInput): {
  data: string;
  mimeType: string;
} {
  const rawData = typeof input.data === "string" ? input.data.trim() : "";
  if (!rawData) {
    throw new Error("Clawline outbound attachment missing data");
  }
  let mimeType = typeof input.mimeType === "string" ? input.mimeType.trim() : "";
  let data = rawData;
  const match = /^data:([^;,]+)(?:;[^,]*)*;base64,([\s\S]*)$/i.exec(rawData);
  if (match) {
    mimeType = mimeType || match[1].trim();
    data = match[2].replace(/\s+/g, "");
  }
  if (!mimeType) {
    mimeType = "application/octet-stream";
  }
  const normalizedMime = mimeType.toLowerCase();
  return {
    data: maybeEncodeJsonDocumentPayload(data, normalizedMime),
    mimeType: normalizedMime,
  };
}

function buildClawlinePersonalSessionKey(agentId: string, userId: string): string {
  return buildClawlineUserStreamSessionKey(agentId, userId, "main");
}

function buildClawlineUserStreamSessionKey(
  agentId: string,
  userId: string,
  streamSuffix: string,
): string {
  const normalizedAgentId = (agentId ?? "").trim().toLowerCase() || "main";
  const normalizedUserId = sanitizeUserId(userId).toLowerCase();
  const normalizedSuffix = sanitizeUserId(streamSuffix).toLowerCase();
  return `agent:${normalizedAgentId}:clawline:${normalizedUserId}:${normalizedSuffix}`;
}

function isCustomStreamSuffix(value: string): boolean {
  return STREAM_SUFFIX_REGEX.test(value.trim().toLowerCase());
}

function generateCustomStreamSuffix(): string {
  return `s_${randomBytes(4).toString("hex")}`;
}

function parseClawlineUserSessionKey(sessionKey: string): {
  agentId: string;
  userId: string;
  streamSuffix: string;
} | null {
  const parts = sessionKey.split(":");
  if (parts.length !== 5) {
    return null;
  }
  if (parts[0]?.toLowerCase() !== "agent" || parts[2]?.toLowerCase() !== "clawline") {
    return null;
  }
  const agentId = (parts[1] ?? "").trim().toLowerCase();
  const userId = sanitizeUserId(parts[3]).toLowerCase();
  const streamSuffix = sanitizeUserId(parts[4]).toLowerCase();
  if (!agentId || !userId || !streamSuffix) {
    return null;
  }
  return { agentId, userId, streamSuffix };
}

function streamKindToDisplayName(kind: StreamSessionKind): string {
  if (kind === "main") {
    return "Personal";
  }
  if (kind === "dm") {
    return "DM";
  }
  if (kind === "global_dm") {
    return "Global DM";
  }
  return STREAM_DISPLAY_NAME_FALLBACK;
}

function isClawlinePersonalUserStreamSessionKey(sessionKey: string, userId?: string): boolean {
  // MVP policy: terminal bubbles are per-user only (never global).
  // Allowed patterns:
  // - agent:<agentId>:clawline:<userId>:main
  // - agent:<agentId>:clawline:<userId>:dm
  const parts = sessionKey.split(":");
  if (parts.length !== 5) {
    return false;
  }
  if (parts[0] !== "agent") {
    return false;
  }
  if (!parts[1]) {
    return false;
  }
  if (parts[2] !== "clawline") {
    return false;
  }
  const expectedUserId = userId ? sanitizeUserId(userId).toLowerCase() : null;
  if (!parts[3] || (expectedUserId && parts[3].toLowerCase() !== expectedUserId)) {
    return false;
  }
  const suffix = parts[4]?.toLowerCase();
  return suffix === "main" || suffix === "dm" || isCustomStreamSuffix(suffix ?? "");
}

function decodeTerminalSessionDescriptorFromBase64(data: string): {
  terminalSessionId: string;
  title?: string;
} | null {
  try {
    const decoded = Buffer.from(data, "base64").toString("utf8");
    const obj = JSON.parse(decoded) as { terminalSessionId?: unknown; title?: unknown };
    const id = typeof obj.terminalSessionId === "string" ? obj.terminalSessionId.trim() : "";
    if (!id) {
      return null;
    }
    const title = typeof obj.title === "string" ? obj.title.trim() : undefined;
    return { terminalSessionId: id, title };
  } catch {
    return null;
  }
}

function describeClawlineAttachments(attachments: NormalizedAttachment[]): string | null {
  if (attachments.length === 0) {
    return null;
  }
  const lines = attachments.map((attachment, index) => {
    const label = `Attachment ${index + 1}`;
    if (attachment.type === "asset") {
      return `${label}: uploaded asset ${attachment.assetId}`;
    }
    const approxBytes = Math.round((attachment.data.length / 4) * 3);
    if (attachment.type === "document") {
      return `${label}: inline document (${attachment.mimeType}, ~${approxBytes} bytes)`;
    }
    return `${label}: inline image (${attachment.mimeType}, ~${approxBytes} bytes)`;
  });
  return `Attachments:\n${lines.join("\n")}`;
}

function summarizeAttachmentStats(attachments?: unknown[]): {
  count: number;
  inlineBytes: number;
  assetCount: number;
} | null {
  if (!attachments || attachments.length === 0) {
    return null;
  }
  let inlineBytes = 0;
  let assetCount = 0;
  let count = 0;
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") {
      continue;
    }
    const typed = attachment as { type?: unknown; data?: unknown };
    if (typed.type === "image" || typed.type === "document") {
      const data = typeof typed.data === "string" ? typed.data : "";
      if (!data) {
        continue;
      }
      inlineBytes += Math.round((data.length / 4) * 3);
      count += 1;
    } else if (typed.type === "asset") {
      assetCount += 1;
      count += 1;
    }
  }
  if (count === 0) {
    return null;
  }
  return { count, inlineBytes, assetCount };
}

function buildAssistantTextFromPayload(payload: ReplyPayload, fallback: string): string | null {
  const parts: string[] = [];
  const text = payload.text?.trim();
  if (text) {
    parts.push(text);
  }
  const mediaUrls = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];
  if (mediaUrls.length > 0) {
    parts.push(mediaUrls.map((url) => `[media] ${url}`).join("\n"));
  }
  if (payload.isError && parts.length > 0) {
    parts[0] = `⚠️ ${parts[0]}`;
  }
  const combined = parts.join("\n\n").trim();
  if (combined) {
    return combined;
  }
  const fallbackText = fallback.trim();
  return fallbackText || null;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  const maxLength = Math.max(bufA.length, bufB.length);
  const paddedA = Buffer.alloc(maxLength);
  const paddedB = Buffer.alloc(maxLength);
  bufA.copy(paddedA);
  bufB.copy(paddedB);
  const equal = timingSafeEqual(paddedA, paddedB);
  return equal && bufA.length === bufB.length;
}

function validateDeviceInfo(value: unknown): value is DeviceInfo {
  if (!value || typeof value !== "object") {
    return false;
  }
  const obj = value as Record<string, unknown>;
  const requiredString = (input: unknown) =>
    typeof input === "string" && input.length > 0 && Buffer.byteLength(input, "utf8") <= 64;
  if (!requiredString(obj.platform) || !requiredString(obj.model)) {
    return false;
  }
  const osVersion = obj.osVersion;
  if (osVersion !== undefined && !requiredString(osVersion) && osVersion !== "") {
    return false;
  }
  const appVersion = obj.appVersion;
  if (appVersion !== undefined && !requiredString(appVersion) && appVersion !== "") {
    return false;
  }
  return true;
}

type PendingConnection = {
  deviceId: string;
  socket: WebSocket;
  claimedName?: string;
  deviceInfo: DeviceInfo;
  createdAt: number;
};

type Session = {
  socket: WebSocket;
  deviceId: string;
  userId: string;
  isAdmin: boolean;
  clientFeatures: Set<string>;
  sessionId: string;
  /** Default session key for legacy clients that omit payload.sessionKey (routes to Main stream). */
  sessionKey: string;
  /** Session keys this socket is subscribed to for outbound delivery. */
  sessionKeys: string[];
  /** Session keys the client is allowed to reference on inbound (may include admin-only keys). */
  provisionedSessionKeys: string[];
  /** Main stream session key (agent:<id>:clawline:<userId>:main). */
  personalSessionKey: string;
  /** dmScope in effect when session was provisioned (debug/UX only). */
  dmScope: string;
  /** DM stream session key (agent:<id>:clawline:<userId>:dm). */
  dmSessionKey: string;
  /** Global DM session key (shared operator session; admin-only). */
  globalSessionKey: string;
  peerId: string;
  claimedName?: string;
  deviceInfo?: DeviceInfo;
};

type ConnectionState = {
  authenticated: boolean;
  deviceId?: string;
  userId?: string;
  isAdmin?: boolean;
  sessionId?: string;
};

type ServerMessage = {
  type: "message";
  id: string;
  role: "user" | "assistant";
  /**
   * Display-only sender label for UI (e.g., configured agent identity name like "CLU").
   * Not used for routing.
   */
  sender?: string;
  content: string;
  timestamp: number;
  streaming: boolean;
  sessionKey?: string;
  attachments?: unknown[];
  deviceId?: string;
};

type StreamServerMessage =
  | StreamSnapshotServerMessage
  | StreamCreatedServerMessage
  | StreamUpdatedServerMessage
  | StreamDeletedServerMessage;

type StreamSessionRow = {
  userId: string;
  sessionKey: string;
  displayName: string;
  kind: StreamSessionKind;
  orderIndex: number;
  isBuiltIn: number;
  createdAt: number;
  updatedAt: number;
};

type StreamMutationIdempotencyRecord = {
  status: number;
  requestKey: string;
  response: Record<string, unknown>;
};

enum MessageStreamingState {
  Finalized = 0,
  Active = 1,
  Failed = 2,
  Queued = 3,
}

type TerminalSessionRecord = {
  terminalSessionId: string;
  ownerUserId: string;
  sessionKey: string;
  title?: string;
  createdAt: number;
  lastSeenAt: number;
  // MVP: terminalSessionId maps directly to a tmux session name on the terminal host.
  tmuxSessionName: string;
};

export const DEFAULT_ALERT_INSTRUCTIONS_TEXT = `After handling this alert, evaluate: would Flynn want to know what happened? If yes, report to him. Don't just process silently.`;

const DEFAULT_CONFIG: ProviderConfig = {
  port: 18800,
  statePath: path.join(os.homedir(), ".openclaw", "clawline"),
  alertInstructionsPath: path.join(os.homedir(), ".openclaw", "clawline", "alert-instructions.md"),
  terminal: {
    tmux: {
      mode: "local",
      ssh: {
        target: "",
        identityFile: null,
        port: null,
        knownHostsFile: null,
        strictHostKeyChecking: "accept-new",
        extraArgs: [],
      },
    },
  },
  network: {
    bindAddress: "127.0.0.1",
    allowInsecurePublic: false,
    allowedOrigins: [],
  },
  adapter: null,
  auth: {
    jwtSigningKey: null,
    tokenTtlSeconds: 31_536_000,
    maxAttemptsPerMinute: 5,
    reissueGraceSeconds: 600,
  },
  pairing: {
    maxPendingRequests: 100,
    maxRequestsPerMinute: 5,
    pendingTtlSeconds: 300,
    pendingSocketTimeoutSeconds: 300,
  },
  media: {
    storagePath: path.join(os.homedir(), ".openclaw", "clawline-media"),
    maxInlineBytes: 262_144,
    maxUploadBytes: 104_857_600,
    unreferencedUploadTtlSeconds: 3600,
  },
  webRootPath: path.join(DEFAULT_AGENT_WORKSPACE_DIR, "www"),
  webRoot: {
    followSymlinks: false,
  },
  sessions: {
    maxMessageBytes: 65_536,
    maxReplayMessages: 500,
    maxPromptMessages: 200,
    maxMessagesPerSecond: 5,
    maxTypingPerSecond: 2,
    typingAutoExpireSeconds: 10,
    maxQueuedMessages: 20,
    maxWriteQueueDepth: 1000,
    adapterExecuteTimeoutSeconds: 300,
    streamInactivitySeconds: 300,
  },
  streams: {
    chunkPersistIntervalMs: 100,
    chunkBufferBytes: 1_048_576,
    maxStreamsPerUser: 32,
    maxDisplayNameBytes: 120,
  },
};

const ALLOWLIST_FILENAME = "allowlist.json";
const PENDING_FILENAME = "pending.json";
const DENYLIST_FILENAME = "denylist.json";
const JWT_KEY_FILENAME = "jwt.key";
const DB_FILENAME = "clawline.sqlite";
const SESSION_REPLACED_CODE = 1000;
const FACE_SPEAK_MAX_CHARS = 500;
const FACE_SPEAK_DEDUPE_TTL_MS = 5 * 60 * 1000;
const FACE_SPEAK_DEDUPE_MAX = 1000;
const FACE_SPEAK_PENDING_MAX = 1000;

// Experimental: best-effort hook for local "face speak" tooling.
// - OFF unless CLU_FACE_SPEAK_URL is set
// - Non-blocking (fire-and-forget)
// - Debug-only logging (no warn/error)
// - Empty text skipped; long text capped
function triggerFaceSpeak(
  text: string,
  logger: Logger,
  meta?: { sessionKey?: string; messageId?: string },
  endpointOverride?: string,
) {
  const endpoint =
    typeof endpointOverride === "string" && endpointOverride.trim().length > 0
      ? endpointOverride.trim()
      : typeof process.env.CLU_FACE_SPEAK_URL === "string"
        ? process.env.CLU_FACE_SPEAK_URL.trim()
        : "";
  if (!endpoint) {
    logger.info?.("[clawline] face_speak_skipped", {
      reason: "missing_endpoint",
      sessionKey: meta?.sessionKey,
      messageId: meta?.messageId,
    });
    return;
  }
  const resolvedEndpoint = (() => {
    try {
      const parsed = new URL(endpoint);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return null;
      }
      const host = parsed.hostname.toLowerCase();
      if (host === "localhost" || host === "::1") {
        return parsed.toString();
      }
      if (net.isIP(host) === 4 && host.startsWith("127.")) {
        return parsed.toString();
      }
      if (net.isIP(host) === 6 && host.startsWith("::ffff:127.")) {
        return parsed.toString();
      }
      return null;
    } catch {
      return null;
    }
  })();
  if (!resolvedEndpoint) {
    logger.info?.("[clawline] face_speak_skipped", {
      reason: "invalid_endpoint",
      sessionKey: meta?.sessionKey,
      messageId: meta?.messageId,
    });
    return;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    logger.info?.("[clawline] face_speak_skipped", {
      reason: "empty_text",
      sessionKey: meta?.sessionKey,
      messageId: meta?.messageId,
    });
    return;
  }
  const capped =
    trimmed.length > FACE_SPEAK_MAX_CHARS ? trimmed.slice(0, FACE_SPEAK_MAX_CHARS) : trimmed;
  const redactedHost = (() => {
    try {
      const host = new URL(resolvedEndpoint).host;
      if (!host) {
        return "redacted";
      }
      return host.replace(/[^.]+/g, "***");
    } catch {
      return "invalid";
    }
  })();
  logger.info?.("[clawline] face_speak_triggered", {
    textLength: capped.length,
    endpointHost: redactedHost,
    sessionKey: meta?.sessionKey,
    messageId: meta?.messageId,
  });
  void (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    try {
      await fetch(resolvedEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: capped }),
        signal: controller.signal,
      });
    } catch (err) {
      logger.info?.("[clawline] face_speak_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(timeout);
    }
  })();
}

function mergeConfig(partial?: Partial<ProviderConfig>): ProviderConfig {
  const merged = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as ProviderConfig;
  if (!partial) {
    return merged;
  }
  return deepMerge(merged, partial);
}

function isLocalhost(address: string): boolean {
  return ["127.0.0.1", "::1", "localhost"].includes(address);
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function loadJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const data = await fs.readFile(filePath, "utf8");
    return JSON.parse(data) as T;
  } catch (err) {
    const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") {
      await fs.writeFile(filePath, JSON.stringify(fallback, null, 2));
      return fallback;
    }
    throw err;
  }
}

async function loadAllowlist(filePath: string): Promise<AllowlistFile> {
  return loadJsonFile<AllowlistFile>(filePath, { version: 1, entries: [] });
}

async function loadPending(filePath: string): Promise<PendingFile> {
  const pending = await loadJsonFile<PendingFile>(filePath, { version: 1, entries: [] });
  if (!Array.isArray(pending.entries)) {
    pending.entries = [];
  }
  return pending;
}

async function loadDenylist(filePath: string): Promise<{ deviceId: string }[]> {
  return loadJsonFile(filePath, [] as { deviceId: string }[]);
}

async function ensureJwtKey(filePath: string, provided?: string | null): Promise<string> {
  const validateKey = (value: string) => {
    const trimmed = value.trim();
    if (Buffer.byteLength(trimmed, "utf8") < 64) {
      throw new Error("JWT signing key must be at least 64 bytes");
    }
    return trimmed;
  };
  if (provided) {
    return validateKey(provided);
  }
  try {
    const data = await fs.readFile(filePath, "utf8");
    return validateKey(data);
  } catch (err) {
    const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
    if (code && code !== "ENOENT") {
      throw err;
    }
    const key = randomBytes(32).toString("hex");
    await fs.writeFile(filePath, key, { mode: 0o600 });
    return key;
  }
}

const userSequenceStmt = (db: SqliteDatabase) =>
  db.prepare(
    `INSERT INTO user_sequences (userId, nextSequence)
     VALUES (?, 1)
     ON CONFLICT(userId)
     DO UPDATE SET nextSequence = user_sequences.nextSequence + 1
     RETURNING nextSequence as sequence`,
  );

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function hashAttachments(attachments: NormalizedAttachment[]): string {
  const quote = (value: string) => JSON.stringify(value);
  if (attachments.length === 0) {
    return sha256("[]");
  }
  const parts = attachments.map((attachment) => {
    switch (attachment.type) {
      case "image":
        return `{"type":"image","mimeType":${quote(attachment.mimeType)},"data":${quote(attachment.data)}}`;
      case "document":
        return `{"type":"document","mimeType":${quote(attachment.mimeType)},"data":${quote(attachment.data)}}`;
      case "asset":
        return `{"type":"asset","assetId":${quote(attachment.assetId)}}`;
    }
  });
  return sha256(`[${parts.join(",")}]`);
}

function nowMs(): number {
  return Date.now();
}

function generateServerMessageId(): string {
  return `s_${randomUUID()}`;
}

function generateUserId(): string {
  return `user_${randomUUID()}`;
}

function parseServerMessage(json: string, logger: Logger): ServerMessage | null {
  try {
    return JSON.parse(json) as ServerMessage;
  } catch (err) {
    logger.warn?.(`replay_parse_failed: ${formatError(err)}`);
    return null;
  }
}

export async function createProviderServer(options: ProviderOptions): Promise<ProviderServer> {
  const config = mergeConfig(options.config);
  const adapterOverrides =
    (options.config as { adapterOverrides?: ClawlineAdapterOverrides } | undefined)
      ?.adapterOverrides ?? {};
  const openClawCfg = options.openClawConfig;
  const dmScope = openClawCfg.session?.dmScope ?? "main";
  const logger: Logger = options.logger ?? console;
  const tmuxBackend = createTerminalTmuxBackend(config, logger);
  const sessionStorePath = options.sessionStorePath;
  const mainSessionKey = options.mainSessionKey?.trim() || "agent:main:main";
  const normalizedMainKey = mainSessionKey.toLowerCase();
  const mainSessionAgentId = resolveAgentIdFromSessionKey(mainSessionKey);

  const resolveAssistantSenderName = (sessionKey: string) =>
    resolveIdentityName(openClawCfg, resolveAgentIdFromSessionKey(sessionKey));

  type SessionInfo = {
    dmScope: string;
    mainSessionKey: string;
    dmSessionKey: string;
    globalSessionKey: string;
    /** All provisioned session keys (may include admin-only keys). */
    provisionedSessionKeys: string[];
    /** Session keys this socket is subscribed to for outbound delivery. */
    subscribedSessionKeys: string[];
  };

  const normalizeSessionKey = (key: string) => key.trim().toLowerCase();
  const sessionKeyEq = (a: string, b: string) => normalizeSessionKey(a) === normalizeSessionKey(b);

  const buildSessionInfo = (userId: string, isAdmin: boolean) => {
    const mainStreamSessionKey = buildClawlinePersonalSessionKey(mainSessionAgentId, userId);
    const globalSessionKey = mainSessionKey;
    const dmSessionKey = buildClawlineUserStreamSessionKey(mainSessionAgentId, userId, "dm");
    const seededStreams = ensureStreamSessionsForUser({ userId, isAdmin });
    const visibleStreamKeys = filterStreamAccess(seededStreams, isAdmin).map(
      (stream) => stream.sessionKey,
    );
    const fallbackKeys = [mainStreamSessionKey];
    if (dmScope !== "main") {
      fallbackKeys.push(dmSessionKey);
    }
    if (isAdmin) {
      fallbackKeys.push(globalSessionKey);
    }
    const dedupeKeys = (keys: string[]) =>
      Array.from(new Map(keys.map((key) => [normalizeSessionKey(key), key])).values());
    const provisionedSessionKeys = dedupeKeys(
      visibleStreamKeys.length > 0 ? visibleStreamKeys : fallbackKeys,
    );
    const subscribedSessionKeys = provisionedSessionKeys;

    return {
      dmScope,
      mainSessionKey: mainStreamSessionKey,
      dmSessionKey,
      globalSessionKey,
      provisionedSessionKeys,
      subscribedSessionKeys,
    } satisfies SessionInfo;
  };
  const applySessionInfo = (session: Session, isAdmin: boolean) => {
    const info = buildSessionInfo(session.userId, isAdmin);
    session.isAdmin = isAdmin;
    session.personalSessionKey = info.mainSessionKey;
    session.dmScope = info.dmScope;
    session.dmSessionKey = info.dmSessionKey;
    session.globalSessionKey = info.globalSessionKey;
    session.provisionedSessionKeys = info.provisionedSessionKeys;
    session.sessionKeys = info.subscribedSessionKeys;
    session.sessionKey = info.mainSessionKey;
    return info;
  };
  const sendSessionInfo = async (session: Session, info?: ReturnType<typeof buildSessionInfo>) => {
    const resolved = info ?? buildSessionInfo(session.userId, session.isAdmin);
    const payload = {
      type: "session_info",
      userId: session.userId,
      isAdmin: session.isAdmin,
      dmScope: resolved.dmScope,
      sessionKeys: resolved.subscribedSessionKeys,
    };
    await sendJson(session.socket, payload).catch(() => {});
  };
  async function notifyGatewayOfPending(entry: PendingEntry) {
    const name = entry.claimedName ?? "New device";
    const platform = entry.deviceInfo.platform || "Unknown platform";
    const text = `New device pending approval: ${name} (${platform})`;
    await wakeGatewayForAlert(text, mainSessionKey);
  }
  const alertInstructionsPath =
    typeof config.alertInstructionsPath === "string" &&
    config.alertInstructionsPath.trim().length > 0
      ? path.resolve(config.alertInstructionsPath.trim())
      : null;

  if (!config.network.allowInsecurePublic && !isLocalhost(config.network.bindAddress)) {
    throw new Error("allowInsecurePublic must be true to bind non-localhost");
  }
  if (
    config.network.allowInsecurePublic &&
    !isLocalhost(config.network.bindAddress) &&
    (!config.network.allowedOrigins || config.network.allowedOrigins.length === 0)
  ) {
    throw new Error("allowedOrigins must be configured when binding to a public interface");
  }

  await ensureDir(config.statePath);
  await ensureDir(config.media.storagePath);
  await ensureDir(config.webRootPath);
  const webRootMediaDir = path.join(config.webRootPath, "media");
  await ensureDir(webRootMediaDir);
  const assetsDir = path.join(config.media.storagePath, "assets");
  const sessionTranscriptsDir = path.join(config.statePath, "sessions");
  const tmpDir = path.join(config.media.storagePath, "tmp");
  await ensureDir(assetsDir);
  await ensureDir(tmpDir);
  await ensureDir(sessionTranscriptsDir);
  const webRootRealPath = await fs.realpath(config.webRootPath);
  const webRootRealPrefix = webRootRealPath.endsWith(path.sep)
    ? webRootRealPath
    : `${webRootRealPath}${path.sep}`;
  if (alertInstructionsPath) {
    await ensureAlertInstructionsFileIfMissing();
  }

  const allowlistPath = path.join(config.statePath, ALLOWLIST_FILENAME);
  const pendingPath = path.join(config.statePath, PENDING_FILENAME);
  const denylistPath = path.join(config.statePath, DENYLIST_FILENAME);
  const jwtKeyPath = path.join(config.statePath, JWT_KEY_FILENAME);
  const dbPath = path.join(config.statePath, DB_FILENAME);

  let allowlist = await loadAllowlist(allowlistPath);
  allowlist.entries.forEach(normalizeAllowlistEntry);
  let pendingFile = await loadPending(pendingPath);
  let denylist = await loadDenylist(denylistPath);
  const jwtKey = await ensureJwtKey(jwtKeyPath, config.auth.jwtSigningKey);

  type AssetHandlers = ReturnType<typeof createAssetHandlers>;

  let db: SqliteDatabase | null = null;
  let sequenceStatement!: ReturnType<typeof userSequenceStmt>;
  let insertEventStmt!: SqliteStatement;
  let updateMessageAckStmt!: SqliteStatement;
  let insertMessageStmt!: SqliteStatement;
  let selectMessageStmt!: SqliteStatement;
  let updateMessageStreamingStmt!: SqliteStatement;
  let insertMessageAssetStmt!: SqliteStatement;
  let insertAssetStmt!: SqliteStatement;
  let selectAssetStmt!: SqliteStatement;
  let selectExpiredAssetsStmt!: SqliteStatement;
  let deleteAssetStmt!: SqliteStatement;
  let selectEventsAfterStmt!: SqliteStatement;
  let selectEventsTailStmt!: SqliteStatement;
  let selectEventByIdStmt!: SqliteStatement;
  let selectEventPayloadForUserStmt!: SqliteStatement;
  let selectEventsAfterTimestampStmt!: SqliteStatement;
  let selectStreamSessionsByUserStmt!: SqliteStatement;
  let selectStreamSessionByKeyStmt!: SqliteStatement;
  let selectStreamMaxOrderStmt!: SqliteStatement;
  let insertStreamSessionStmt!: SqliteStatement;
  let updateStreamSessionDisplayNameStmt!: SqliteStatement;
  let updateStreamSessionBuiltInMetadataStmt!: SqliteStatement;
  let deleteStreamSessionStmt!: SqliteStatement;
  let selectStreamIdempotencyStmt!: SqliteStatement;
  let insertStreamIdempotencyStmt!: SqliteStatement;
  let deleteExpiredStreamIdempotencyStmt!: SqliteStatement;
  let deleteMessageAssetsBySessionStmt!: SqliteStatement;
  let deleteMessagesBySessionStmt!: SqliteStatement;
  let deleteEventsBySessionStmt!: SqliteStatement;
  let selectOrphanedAssetsForUserStmt!: SqliteStatement;
  let deleteOrphanedAssetByIdStmt!: SqliteStatement;
  let insertUserMessageTx!: ReturnType<SqliteDatabase["transaction"]>;
  let insertEventTx!: ReturnType<SqliteDatabase["transaction"]>;
  let deleteStreamDataTx!: ReturnType<SqliteDatabase["transaction"]>;
  let handleUpload!: AssetHandlers["handleUpload"];
  let handleDownload!: AssetHandlers["handleDownload"];
  let cleanupTmpDirectory!: AssetHandlers["cleanupTmpDirectory"];
  let cleanupOrphanedAssetFiles!: AssetHandlers["cleanupOrphanedAssetFiles"];
  let cleanupUnreferencedAssets!: AssetHandlers["cleanupUnreferencedAssets"];
  let streamIdempotencyCleanupInterval: ReturnType<typeof setInterval> | null = null;

  const normalizeStoredSessionKey = (rawSessionKey: string, fallbackUserId?: string): string => {
    const trimmed = rawSessionKey.trim();
    if (!trimmed) {
      if (fallbackUserId) {
        return buildClawlinePersonalSessionKey(mainSessionAgentId, fallbackUserId);
      }
      return "";
    }
    if (sessionKeyEq(trimmed, mainSessionKey)) {
      return mainSessionKey;
    }
    const parsed = parseClawlineUserSessionKey(trimmed);
    if (parsed) {
      if (parsed.streamSuffix === "main" || parsed.streamSuffix === "dm") {
        return buildClawlineUserStreamSessionKey(
          parsed.agentId,
          parsed.userId,
          parsed.streamSuffix,
        );
      }
      if (isCustomStreamSuffix(parsed.streamSuffix)) {
        return buildClawlineUserStreamSessionKey(
          parsed.agentId,
          parsed.userId,
          parsed.streamSuffix,
        );
      }
    }
    const legacyParts = trimmed.split(":");
    if (
      legacyParts.length === 5 &&
      legacyParts[0]?.toLowerCase() === "agent" &&
      legacyParts[2]?.toLowerCase() === "clawline" &&
      legacyParts[3]?.toLowerCase() === "dm"
    ) {
      const agentId = (legacyParts[1] ?? "").trim().toLowerCase() || "main";
      const legacyUserId = sanitizeUserId(legacyParts[4]).toLowerCase();
      if (!legacyUserId) {
        return "";
      }
      return buildClawlinePersonalSessionKey(agentId, legacyUserId);
    }
    if (fallbackUserId) {
      return buildClawlinePersonalSessionKey(mainSessionAgentId, fallbackUserId);
    }
    return "";
  };

  const streamSessionFromRow = (row: StreamSessionRow): StreamSession => ({
    sessionKey: row.sessionKey,
    displayName: row.displayName,
    kind: row.kind,
    orderIndex: row.orderIndex,
    isBuiltIn: row.isBuiltIn === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  const streamResponseSort = (a: StreamSession, b: StreamSession) => {
    if (a.orderIndex !== b.orderIndex) {
      return a.orderIndex - b.orderIndex;
    }
    return a.sessionKey.localeCompare(b.sessionKey);
  };

  const readStreamSessionsForUser = (userId: string): StreamSession[] => {
    if (!selectStreamSessionsByUserStmt) {
      return [];
    }
    const rows = selectStreamSessionsByUserStmt.all(userId) as StreamSessionRow[];
    return rows.map(streamSessionFromRow).toSorted(streamResponseSort);
  };

  const filterStreamAccess = (streams: StreamSession[], isAdmin: boolean): StreamSession[] => {
    if (isAdmin) {
      return streams;
    }
    return streams.filter((stream) => !sessionKeyEq(stream.sessionKey, mainSessionKey));
  };

  const applyStreamSubscriptionsToSession = (session: Session, streams: StreamSession[]) => {
    const visible = filterStreamAccess(streams, session.isAdmin);
    const keys = Array.from(
      new Map(
        visible.map((stream) => [normalizeSessionKey(stream.sessionKey), stream.sessionKey]),
      ).values(),
    );
    session.provisionedSessionKeys = keys;
    session.sessionKeys = keys;
    if (!keys.some((key) => sessionKeyEq(key, session.sessionKey))) {
      const preferred = keys.find((key) => sessionKeyEq(key, session.personalSessionKey));
      session.sessionKey = preferred ?? keys[0] ?? session.personalSessionKey;
    }
  };

  const syncUserSessionSubscriptions = (userId: string, streams?: StreamSession[]) => {
    const resolved = streams ?? readStreamSessionsForUser(userId);
    const sessions = userSessions.get(userId);
    if (!sessions) {
      return;
    }
    for (const session of sessions) {
      applyStreamSubscriptionsToSession(session, resolved);
    }
  };

  const seedDefaultStreamsForUser = (params: {
    userId: string;
    isAdmin: boolean;
    now: number;
  }): StreamSession[] => {
    const entries: Array<{
      sessionKey: string;
      kind: StreamSessionKind;
      displayName: string;
      orderIndex: number;
      isBuiltIn: number;
    }> = [];
    const mainKey = buildClawlinePersonalSessionKey(mainSessionAgentId, params.userId);
    entries.push({
      sessionKey: mainKey,
      kind: "main",
      displayName: streamKindToDisplayName("main"),
      orderIndex: entries.length,
      isBuiltIn: 1,
    });
    if (dmScope !== "main") {
      entries.push({
        sessionKey: buildClawlineUserStreamSessionKey(mainSessionAgentId, params.userId, "dm"),
        kind: "dm",
        displayName: `${params.userId} DM`,
        orderIndex: entries.length,
        isBuiltIn: 1,
      });
    }
    if (params.isAdmin) {
      entries.push({
        sessionKey: mainSessionKey,
        kind: "global_dm",
        displayName: "Global DM",
        orderIndex: entries.length,
        isBuiltIn: 1,
      });
    }
    for (const entry of entries) {
      insertStreamSessionStmt.run(
        params.userId,
        entry.sessionKey,
        entry.displayName,
        entry.kind,
        entry.orderIndex,
        entry.isBuiltIn,
        params.now,
        params.now,
      );
    }
    return readStreamSessionsForUser(params.userId);
  };

  const ensureStreamSessionsForUser = (params: {
    userId: string;
    isAdmin: boolean;
  }): StreamSession[] => {
    if (!selectStreamSessionsByUserStmt || !insertStreamSessionStmt || !selectStreamMaxOrderStmt) {
      const fallback: StreamSession[] = [
        {
          sessionKey: buildClawlinePersonalSessionKey(mainSessionAgentId, params.userId),
          displayName: streamKindToDisplayName("main"),
          kind: "main",
          orderIndex: 0,
          isBuiltIn: true,
          createdAt: 0,
          updatedAt: 0,
        },
      ];
      if (dmScope !== "main") {
        fallback.push({
          sessionKey: buildClawlineUserStreamSessionKey(mainSessionAgentId, params.userId, "dm"),
          displayName: `${params.userId} DM`,
          kind: "dm",
          orderIndex: fallback.length,
          isBuiltIn: true,
          createdAt: 0,
          updatedAt: 0,
        });
      }
      if (params.isAdmin) {
        fallback.push({
          sessionKey: mainSessionKey,
          displayName: "Global DM",
          kind: "global_dm",
          orderIndex: fallback.length,
          isBuiltIn: true,
          createdAt: 0,
          updatedAt: 0,
        });
      }
      return fallback;
    }
    const now = nowMs();
    let streams = readStreamSessionsForUser(params.userId);
    if (streams.length === 0) {
      streams = seedDefaultStreamsForUser({
        userId: params.userId,
        isAdmin: params.isAdmin,
        now,
      });
    }
    const builtIns: Array<{
      sessionKey: string;
      kind: StreamSessionKind;
      displayName: string;
    }> = [
      {
        sessionKey: buildClawlinePersonalSessionKey(mainSessionAgentId, params.userId),
        kind: "main",
        displayName: streamKindToDisplayName("main"),
      },
    ];
    if (dmScope !== "main") {
      builtIns.push({
        sessionKey: buildClawlineUserStreamSessionKey(mainSessionAgentId, params.userId, "dm"),
        kind: "dm",
        displayName: `${params.userId} DM`,
      });
    }
    if (params.isAdmin) {
      builtIns.push({
        sessionKey: mainSessionKey,
        kind: "global_dm",
        displayName: "Global DM",
      });
    }
    let maxOrderRow = selectStreamMaxOrderStmt.get(params.userId) as { maxOrder: number | null };
    let nextOrder = (maxOrderRow?.maxOrder ?? -1) + 1;
    const streamByKey = new Map(
      streams.map((stream) => [normalizeSessionKey(stream.sessionKey), stream] as const),
    );
    let changed = false;
    for (const builtIn of builtIns) {
      const existing = streamByKey.get(normalizeSessionKey(builtIn.sessionKey));
      if (!existing) {
        insertStreamSessionStmt.run(
          params.userId,
          builtIn.sessionKey,
          builtIn.displayName,
          builtIn.kind,
          nextOrder,
          1,
          now,
          now,
        );
        nextOrder += 1;
        changed = true;
        continue;
      }
      if (
        existing.kind !== builtIn.kind ||
        existing.displayName !== builtIn.displayName ||
        !existing.isBuiltIn
      ) {
        updateStreamSessionBuiltInMetadataStmt.run(
          builtIn.displayName,
          builtIn.kind,
          now,
          params.userId,
          builtIn.sessionKey,
        );
        changed = true;
      }
    }
    if (changed) {
      streams = readStreamSessionsForUser(params.userId);
    }
    return streams;
  };

  function migrateDatabaseToV2(database: SqliteDatabase) {
    const tableHasColumn = (tableName: string, columnName: string): boolean => {
      const rows = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
        name: string;
      }>;
      return rows.some((row) => row.name === columnName);
    };

    const currentVersion = Number(database.pragma("user_version", { simple: true }) ?? 0);

    if (!tableHasColumn("events", "eventType")) {
      database.exec(`ALTER TABLE events ADD COLUMN eventType TEXT NOT NULL DEFAULT 'message'`);
    }
    if (!tableHasColumn("events", "sessionKey")) {
      database.exec(`ALTER TABLE events ADD COLUMN sessionKey TEXT`);
    }

    database.exec(`
      CREATE TABLE IF NOT EXISTS stream_sessions (
        userId TEXT NOT NULL,
        sessionKey TEXT NOT NULL,
        displayName TEXT NOT NULL,
        kind TEXT NOT NULL,
        orderIndex INTEGER NOT NULL,
        isBuiltIn INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (userId, sessionKey),
        UNIQUE (userId, orderIndex)
      );
      CREATE INDEX IF NOT EXISTS idx_stream_sessions_user_order
        ON stream_sessions(userId, orderIndex);
      CREATE TABLE IF NOT EXISTS stream_idempotency (
        userId TEXT NOT NULL,
        idempotencyKey TEXT NOT NULL,
        operation TEXT NOT NULL,
        responseJson TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        PRIMARY KEY (userId, idempotencyKey)
      );
      CREATE INDEX IF NOT EXISTS idx_stream_idempotency_created
        ON stream_idempotency(createdAt);
      CREATE INDEX IF NOT EXISTS idx_events_user_type_sequence
        ON events(userId, eventType, sequence);
      CREATE INDEX IF NOT EXISTS idx_events_user_session_sequence
        ON events(userId, sessionKey, sequence);
    `);

    const knownUsers = new Set<string>();
    for (const entry of allowlist.entries) {
      const userId = sanitizeUserId(entry.userId);
      if (userId) {
        knownUsers.add(userId);
      }
    }
    const userRows = database.prepare(`SELECT DISTINCT userId FROM events`).all() as Array<{
      userId: string;
    }>;
    for (const row of userRows) {
      const userId = sanitizeUserId(row.userId);
      if (userId) {
        knownUsers.add(userId);
      }
    }
    const streamUsers = database
      .prepare(`SELECT DISTINCT userId FROM stream_sessions`)
      .all() as Array<{ userId: string }>;
    for (const row of streamUsers) {
      const userId = sanitizeUserId(row.userId);
      if (userId) {
        knownUsers.add(userId);
      }
    }

    const historicalByUser = new Map<string, Set<string>>();
    const collectKey = (userId: string, rawSessionKey: string) => {
      const normalizedUserId = sanitizeUserId(userId);
      if (!normalizedUserId) {
        return;
      }
      const normalizedSessionKey = normalizeStoredSessionKey(rawSessionKey, normalizedUserId);
      if (!normalizedSessionKey) {
        return;
      }
      const set = historicalByUser.get(normalizedUserId) ?? new Set<string>();
      set.add(normalizedSessionKey);
      historicalByUser.set(normalizedUserId, set);
      knownUsers.add(normalizedUserId);
    };

    const eventSessionRows = database
      .prepare(`SELECT DISTINCT userId, sessionKey FROM events WHERE sessionKey IS NOT NULL`)
      .all() as Array<{ userId: string; sessionKey: string }>;
    for (const row of eventSessionRows) {
      collectKey(row.userId, row.sessionKey);
    }

    if (tableHasColumn("messages", "sessionKey")) {
      const messageSessionRows = database
        .prepare(`SELECT DISTINCT userId, sessionKey FROM messages WHERE sessionKey IS NOT NULL`)
        .all() as Array<{ userId: string; sessionKey: string }>;
      for (const row of messageSessionRows) {
        collectKey(row.userId, row.sessionKey);
      }
    }

    const isAdminUserId = new Set(
      allowlist.entries
        .filter((entry) => entry.isAdmin)
        .map((entry) => sanitizeUserId(entry.userId))
        .filter((value) => value.length > 0),
    );
    const now = nowMs();
    const selectMaxOrderForUser = database.prepare(
      `SELECT MAX(orderIndex) as maxOrder FROM stream_sessions WHERE userId = ?`,
    );
    const insertStreamSession = database.prepare(
      `INSERT OR IGNORE INTO stream_sessions
         (userId, sessionKey, displayName, kind, orderIndex, isBuiltIn, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const selectExistingStreamsForUser = database.prepare(
      `SELECT sessionKey, kind, displayName, isBuiltIn FROM stream_sessions WHERE userId = ?`,
    );
    const updateBuiltInStreamMetadata = database.prepare(
      `UPDATE stream_sessions
       SET displayName = ?, kind = ?, isBuiltIn = 1, updatedAt = ?
       WHERE userId = ? AND sessionKey = ?`,
    );

    const insertCustomStreamsForUser = (userId: string, discovered: Set<string>) => {
      const existing = database
        .prepare(`SELECT sessionKey FROM stream_sessions WHERE userId = ?`)
        .all(userId) as Array<{ sessionKey: string }>;
      const existingKeys = new Set(existing.map((row) => normalizeSessionKey(row.sessionKey)));
      let maxOrder = (selectMaxOrderForUser.get(userId) as { maxOrder: number | null } | undefined)
        ?.maxOrder;
      if (maxOrder == null) {
        maxOrder = -1;
      }
      for (const key of Array.from(discovered).toSorted()) {
        if (sessionKeyEq(key, mainSessionKey)) {
          continue;
        }
        const parsed = parseClawlineUserSessionKey(key);
        if (!parsed || parsed.userId !== sanitizeUserId(userId).toLowerCase()) {
          continue;
        }
        if (parsed.streamSuffix === "main" || parsed.streamSuffix === "dm") {
          continue;
        }
        if (!isCustomStreamSuffix(parsed.streamSuffix)) {
          continue;
        }
        if (existingKeys.has(normalizeSessionKey(key))) {
          continue;
        }
        maxOrder += 1;
        insertStreamSession.run(
          userId,
          key,
          STREAM_DISPLAY_NAME_FALLBACK,
          "custom",
          maxOrder,
          0,
          now,
          now,
        );
        existingKeys.add(normalizeSessionKey(key));
      }
    };

    const ensureBuiltInsForUser = (userId: string) => {
      const discovered = historicalByUser.get(userId) ?? new Set<string>();
      const builtIns: Array<{ sessionKey: string; kind: StreamSessionKind; displayName: string }> =
        [
          {
            sessionKey: buildClawlinePersonalSessionKey(mainSessionAgentId, userId),
            kind: "main",
            displayName: streamKindToDisplayName("main"),
          },
        ];
      if (dmScope !== "main") {
        builtIns.push({
          sessionKey: buildClawlineUserStreamSessionKey(mainSessionAgentId, userId, "dm"),
          kind: "dm",
          displayName: `${userId} DM`,
        });
      }
      if (
        isAdminUserId.has(userId) ||
        Array.from(discovered).some((sessionKey) => sessionKeyEq(sessionKey, mainSessionKey))
      ) {
        builtIns.push({
          sessionKey: mainSessionKey,
          kind: "global_dm",
          displayName: "Global DM",
        });
      }
      const existingRows = selectExistingStreamsForUser.all(userId) as Array<{
        sessionKey: string;
        kind: StreamSessionKind;
        displayName: string;
        isBuiltIn: number;
      }>;
      const byKey = new Map(existingRows.map((row) => [normalizeSessionKey(row.sessionKey), row]));
      let maxOrder = (selectMaxOrderForUser.get(userId) as { maxOrder: number | null } | undefined)
        ?.maxOrder;
      if (maxOrder == null) {
        maxOrder = -1;
      }
      for (const builtIn of builtIns) {
        const existing = byKey.get(normalizeSessionKey(builtIn.sessionKey));
        if (!existing) {
          maxOrder += 1;
          insertStreamSession.run(
            userId,
            builtIn.sessionKey,
            builtIn.displayName,
            builtIn.kind,
            maxOrder,
            1,
            now,
            now,
          );
          continue;
        }
        if (
          existing.kind !== builtIn.kind ||
          existing.displayName !== builtIn.displayName ||
          existing.isBuiltIn !== 1
        ) {
          updateBuiltInStreamMetadata.run(
            builtIn.displayName,
            builtIn.kind,
            now,
            userId,
            builtIn.sessionKey,
          );
        }
      }
    };

    for (const userId of Array.from(knownUsers).toSorted()) {
      ensureBuiltInsForUser(userId);
      if (currentVersion < STREAM_DB_VERSION) {
        const discovered = historicalByUser.get(userId) ?? new Set<string>();
        insertCustomStreamsForUser(userId, discovered);
      }
    }

    if (currentVersion >= STREAM_DB_VERSION) {
      return;
    }

    const selectEventsForBackfill = database.prepare(
      `SELECT id, userId, payloadJson, sessionKey
       FROM events
       WHERE eventType = 'message'`,
    );
    const updateEventSessionKey = database.prepare(`UPDATE events SET sessionKey = ? WHERE id = ?`);
    const backfillRows = selectEventsForBackfill.all() as Array<{
      id: string;
      userId: string;
      payloadJson: string;
      sessionKey: string | null;
    }>;
    const runBackfill = database.transaction(() => {
      for (const row of backfillRows) {
        const normalizedUserId = sanitizeUserId(row.userId);
        if (!normalizedUserId) {
          continue;
        }
        let resolvedSessionKey = normalizeStoredSessionKey(row.sessionKey ?? "");
        if (!resolvedSessionKey) {
          try {
            const payload = JSON.parse(row.payloadJson) as {
              type?: unknown;
              sessionKey?: unknown;
            };
            if (payload.type === "message" && typeof payload.sessionKey === "string") {
              resolvedSessionKey = normalizeStoredSessionKey(payload.sessionKey, normalizedUserId);
            }
          } catch {
            resolvedSessionKey = "";
          }
        }
        if (!resolvedSessionKey) {
          resolvedSessionKey = buildClawlinePersonalSessionKey(
            mainSessionAgentId,
            normalizedUserId,
          );
        }
        if (!row.sessionKey || !sessionKeyEq(row.sessionKey, resolvedSessionKey)) {
          updateEventSessionKey.run(resolvedSessionKey, row.id);
        }
        collectKey(normalizedUserId, resolvedSessionKey);
      }
    });
    runBackfill();

    for (const [userId, discovered] of historicalByUser) {
      insertCustomStreamsForUser(userId, discovered);
    }

    database.pragma(`user_version = ${STREAM_DB_VERSION}`);
  }

  function initializeDatabaseResources(): boolean {
    if (db) {
      return false;
    }
    const newDb = new BetterSqlite3(dbPath, { fileMustExist: false, timeout: 5000 });
    newDb.exec("PRAGMA journal_mode = WAL");
    newDb.exec("PRAGMA foreign_keys = ON");
    newDb.exec(`
      CREATE TABLE IF NOT EXISTS user_sequences (
        userId TEXT PRIMARY KEY,
        nextSequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        originatingDeviceId TEXT,
        payloadJson TEXT NOT NULL,
        payloadBytes INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        eventType TEXT NOT NULL DEFAULT 'message',
        sessionKey TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_userId_sequence ON events(userId, sequence);
      CREATE INDEX IF NOT EXISTS idx_events_userId ON events(userId);
      CREATE TABLE IF NOT EXISTS messages (
        deviceId TEXT NOT NULL,
        userId TEXT NOT NULL,
        clientId TEXT NOT NULL,
        serverEventId TEXT NOT NULL,
        serverSequence INTEGER NOT NULL,
        content TEXT NOT NULL,
        contentHash TEXT NOT NULL,
        attachmentsHash TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        streaming INTEGER NOT NULL,
        ackSent INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (deviceId, clientId)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_userId ON messages(userId);
      CREATE INDEX IF NOT EXISTS idx_messages_serverEventId ON messages(serverEventId);
      CREATE TABLE IF NOT EXISTS assets (
        assetId TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        mimeType TEXT NOT NULL,
        size INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        uploaderDeviceId TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_assets_userId ON assets(userId);
      CREATE INDEX IF NOT EXISTS idx_assets_createdAt ON assets(createdAt);
      CREATE TABLE IF NOT EXISTS message_assets (
        deviceId TEXT NOT NULL,
        clientId TEXT NOT NULL,
        assetId TEXT NOT NULL,
        PRIMARY KEY (deviceId, clientId, assetId),
        FOREIGN KEY (deviceId, clientId) REFERENCES messages(deviceId, clientId) ON DELETE CASCADE,
        FOREIGN KEY (assetId) REFERENCES assets(assetId) ON DELETE RESTRICT
      );
      CREATE INDEX IF NOT EXISTS idx_message_assets_assetId ON message_assets(assetId);
    `);

    migrateDatabaseToV2(newDb);

    sequenceStatement = userSequenceStmt(newDb);
    insertEventStmt = newDb.prepare(
      `INSERT INTO events
         (id, userId, sequence, originatingDeviceId, payloadJson, payloadBytes, timestamp, eventType, sessionKey)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    updateMessageAckStmt = newDb.prepare(
      `UPDATE messages SET ackSent = 1 WHERE deviceId = ? AND clientId = ?`,
    );
    insertMessageStmt = newDb.prepare(
      `INSERT INTO messages (deviceId, userId, clientId, serverEventId, serverSequence, content, contentHash, attachmentsHash, timestamp, streaming, ackSent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${MessageStreamingState.Active}, 0)`,
    );
    selectMessageStmt = newDb.prepare(
      `SELECT deviceId, userId, clientId, serverEventId, serverSequence, content, contentHash, attachmentsHash, timestamp, streaming, ackSent
       FROM messages WHERE deviceId = ? AND clientId = ?`,
    );
    updateMessageStreamingStmt = newDb.prepare(
      `UPDATE messages SET streaming = ? WHERE deviceId = ? AND clientId = ?`,
    );
    insertMessageAssetStmt = newDb.prepare(
      `INSERT INTO message_assets (deviceId, clientId, assetId) VALUES (?, ?, ?)`,
    );
    insertAssetStmt = newDb.prepare(
      `INSERT INTO assets (assetId, userId, mimeType, size, createdAt, uploaderDeviceId) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    selectAssetStmt = newDb.prepare(
      `SELECT assetId, userId, mimeType, size, createdAt FROM assets WHERE assetId = ?`,
    );
    selectExpiredAssetsStmt = newDb.prepare(
      `SELECT assetId FROM assets
       WHERE createdAt <= ?
         AND NOT EXISTS (
           SELECT 1 FROM message_assets WHERE message_assets.assetId = assets.assetId
         )`,
    );
    deleteAssetStmt = newDb.prepare(
      `DELETE FROM assets
       WHERE assetId = ?
         AND NOT EXISTS (
           SELECT 1 FROM message_assets WHERE message_assets.assetId = assets.assetId
         )`,
    );
    selectStreamSessionsByUserStmt = newDb.prepare(
      `SELECT userId, sessionKey, displayName, kind, orderIndex, isBuiltIn, createdAt, updatedAt
       FROM stream_sessions
       WHERE userId = ?
       ORDER BY orderIndex ASC`,
    );
    selectStreamSessionByKeyStmt = newDb.prepare(
      `SELECT userId, sessionKey, displayName, kind, orderIndex, isBuiltIn, createdAt, updatedAt
       FROM stream_sessions
       WHERE userId = ? AND sessionKey = ?`,
    );
    selectStreamMaxOrderStmt = newDb.prepare(
      `SELECT MAX(orderIndex) as maxOrder FROM stream_sessions WHERE userId = ?`,
    );
    insertStreamSessionStmt = newDb.prepare(
      `INSERT INTO stream_sessions
         (userId, sessionKey, displayName, kind, orderIndex, isBuiltIn, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    updateStreamSessionDisplayNameStmt = newDb.prepare(
      `UPDATE stream_sessions
       SET displayName = ?, updatedAt = ?
       WHERE userId = ? AND sessionKey = ?`,
    );
    updateStreamSessionBuiltInMetadataStmt = newDb.prepare(
      `UPDATE stream_sessions
       SET displayName = ?, kind = ?, isBuiltIn = 1, updatedAt = ?
       WHERE userId = ? AND sessionKey = ?`,
    );
    deleteStreamSessionStmt = newDb.prepare(
      `DELETE FROM stream_sessions WHERE userId = ? AND sessionKey = ?`,
    );
    selectStreamIdempotencyStmt = newDb.prepare(
      `SELECT operation, responseJson FROM stream_idempotency WHERE userId = ? AND idempotencyKey = ?`,
    );
    insertStreamIdempotencyStmt = newDb.prepare(
      `INSERT INTO stream_idempotency (userId, idempotencyKey, operation, responseJson, createdAt)
       VALUES (?, ?, ?, ?, ?)`,
    );
    deleteExpiredStreamIdempotencyStmt = newDb.prepare(
      `DELETE FROM stream_idempotency WHERE createdAt < ?`,
    );
    deleteMessageAssetsBySessionStmt = newDb.prepare(
      `DELETE FROM message_assets
       WHERE EXISTS (
         SELECT 1
         FROM messages
         JOIN events ON events.id = messages.serverEventId
         WHERE messages.deviceId = message_assets.deviceId
           AND messages.clientId = message_assets.clientId
           AND messages.userId = ?
           AND events.userId = ?
           AND events.sessionKey = ?
       )`,
    );
    deleteMessagesBySessionStmt = newDb.prepare(
      `DELETE FROM messages
       WHERE userId = ?
         AND serverEventId IN (
           SELECT id FROM events WHERE userId = ? AND sessionKey = ?
         )`,
    );
    deleteEventsBySessionStmt = newDb.prepare(
      `DELETE FROM events WHERE userId = ? AND sessionKey = ?`,
    );
    selectOrphanedAssetsForUserStmt = newDb.prepare(
      `SELECT assetId
       FROM assets
       WHERE userId = ?
         AND NOT EXISTS (
           SELECT 1 FROM message_assets WHERE message_assets.assetId = assets.assetId
         )`,
    );
    deleteOrphanedAssetByIdStmt = newDb.prepare(
      `DELETE FROM assets
       WHERE assetId = ?
         AND NOT EXISTS (
           SELECT 1 FROM message_assets WHERE message_assets.assetId = assets.assetId
         )`,
    );
    ({
      handleUpload,
      handleDownload,
      cleanupTmpDirectory,
      cleanupOrphanedAssetFiles,
      cleanupUnreferencedAssets,
    } = createAssetHandlers({
      config,
      tmpDir,
      assetsDir,
      logger,
      selectAssetStmt,
      deleteAssetStmt,
      insertAssetStmt,
      selectExpiredAssetsStmt,
      enqueueWriteTask,
      authenticateHttpRequest,
      sendHttpError,
      safeUnlink,
      nowMs,
      assetIdRegex: ASSET_ID_REGEX,
      canAccessAsset: ({ assetOwnerId, auth }) =>
        // Admins can access any asset; users can access their own
        auth.isAdmin || assetOwnerId === auth.userId,
    }));

    insertUserMessageTx = newDb.transaction(
      (
        session: Session,
        targetUserId: string,
        messageId: string,
        content: string,
        timestamp: number,
        attachments: NormalizedAttachment[],
        attachmentsHash: string,
        assetIds: string[],
        sessionKey: string,
      ) => {
        for (const assetId of assetIds) {
          const asset = selectAssetStmt.get(assetId) as
            | { assetId: string; userId: string }
            | undefined;
          if (!asset) {
            throw new ClientMessageError("asset_not_found", "Asset not found");
          }
          // All channel types: assets must be owned by the session user
          const allowedOwners = new Set([session.userId]);
          if (!allowedOwners.has(asset.userId)) {
            throw new ClientMessageError("asset_not_found", "Asset not found");
          }
        }
        const serverMessageId = generateServerMessageId();
        const event: ServerMessage = {
          type: "message",
          id: serverMessageId,
          role: "user",
          content,
          timestamp,
          streaming: false,
          deviceId: session.deviceId,
          attachments: attachments.length > 0 ? attachments : undefined,
          sessionKey,
        };
        const payloadJson = JSON.stringify(event);
        const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
        const sequenceRow = sequenceStatement.get(targetUserId) as { sequence: number };
        insertEventStmt.run(
          serverMessageId,
          targetUserId,
          sequenceRow.sequence,
          session.deviceId,
          payloadJson,
          payloadBytes,
          timestamp,
          "message",
          sessionKey,
        );
        insertMessageStmt.run(
          session.deviceId,
          targetUserId,
          messageId,
          serverMessageId,
          sequenceRow.sequence,
          content,
          sha256(content),
          attachmentsHash,
          timestamp,
        );
        for (const assetId of assetIds) {
          insertMessageAssetStmt.run(session.deviceId, messageId, assetId);
        }
        return { event, sequence: sequenceRow.sequence };
      },
    );

    selectEventsAfterStmt = newDb.prepare(
      `SELECT id, payloadJson
       FROM events
       WHERE userId = ? AND eventType = 'message' AND sequence > ?
       ORDER BY sequence ASC`,
    );
    selectEventsTailStmt = newDb.prepare(
      `SELECT id, payloadJson
       FROM events
       WHERE userId = ? AND eventType = 'message'
       ORDER BY sequence DESC LIMIT ?`,
    );
    selectEventByIdStmt = newDb.prepare(
      `SELECT id, userId, sequence, timestamp FROM events WHERE id = ? AND eventType = 'message'`,
    );
    selectEventPayloadForUserStmt = newDb.prepare(
      `SELECT payloadJson FROM events WHERE userId = ? AND id = ? AND eventType = 'message'`,
    );
    selectEventsAfterTimestampStmt = newDb.prepare(
      `SELECT id, payloadJson
       FROM events
       WHERE userId = ? AND eventType = 'message' AND timestamp > ?
       ORDER BY sequence ASC`,
    );
    insertEventTx = newDb.transaction(
      (event: ServerMessage, userId: string, originatingDeviceId?: string) => {
        const payloadJson = JSON.stringify(event);
        const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
        const sequenceRow = sequenceStatement.get(userId) as { sequence: number };
        const normalizedSessionKey =
          typeof event.sessionKey === "string"
            ? normalizeStoredSessionKey(event.sessionKey, userId)
            : "";
        insertEventStmt.run(
          event.id,
          userId,
          sequenceRow.sequence,
          originatingDeviceId ?? null,
          payloadJson,
          payloadBytes,
          event.timestamp,
          "message",
          normalizedSessionKey || null,
        );
        return sequenceRow.sequence;
      },
    );

    deleteStreamDataTx = newDb.transaction((params: { userId: string; sessionKey: string }) => {
      const orphanCandidates = selectOrphanedAssetsForUserStmt.all(params.userId) as Array<{
        assetId: string;
      }>;
      deleteMessageAssetsBySessionStmt.run(params.userId, params.userId, params.sessionKey);
      deleteMessagesBySessionStmt.run(params.userId, params.userId, params.sessionKey);
      deleteEventsBySessionStmt.run(params.userId, params.sessionKey);
      deleteStreamSessionStmt.run(params.userId, params.sessionKey);
      const deletedAssetIds: string[] = [];
      for (const row of orphanCandidates) {
        const result = deleteOrphanedAssetByIdStmt.run(row.assetId);
        if (result.changes > 0) {
          deletedAssetIds.push(row.assetId);
        }
      }
      return deletedAssetIds;
    });

    deleteExpiredStreamIdempotencyStmt.run(nowMs() - STREAM_IDEMPOTENCY_RETENTION_MS);

    db = newDb;
    return true;
  }

  function disposeDatabaseResources() {
    if (db) {
      db.close();
      db = null;
    }
  }

  async function materializeOutboundAttachments(params: {
    attachments: ClawlineOutboundAttachmentInput[];
    ownerUserId: string;
    uploaderDeviceId: string;
  }): Promise<{ attachments: NormalizedAttachment[]; assetIds: string[] }> {
    if (params.attachments.length === 0) {
      return { attachments: [], assetIds: [] };
    }
    const resolved: NormalizedAttachment[] = [];
    const assetIds: string[] = [];
    for (const attachment of params.attachments) {
      if (!attachment || typeof attachment !== "object") {
        throw new Error("Clawline outbound attachment must be an object");
      }
      const { data, mimeType } = normalizeOutboundAttachmentData(attachment);
      const buffer = Buffer.from(data, "base64");
      if (buffer.length === 0) {
        throw new Error("Clawline outbound attachment is empty");
      }
      if (buffer.length > config.media.maxUploadBytes) {
        throw new Error("Clawline outbound attachment exceeds max upload size");
      }
      const isInlineImage = INLINE_IMAGE_MIME_TYPES.has(mimeType);
      if (isInlineImage) {
        resolved.push({ type: "image", mimeType, data });
        continue;
      }
      if (INLINE_DOCUMENT_MIME_TYPES.has(mimeType)) {
        // Certain document descriptors must stay inline so clients can render immediately without
        // downloading an asset first.
        if (buffer.length > config.media.maxInlineBytes) {
          if (mimeType === TERMINAL_SESSION_MIME) {
            throw new Error("Clawline terminal session descriptor exceeds maxInlineBytes");
          }
          if (mimeType === INTERACTIVE_HTML_MIME) {
            throw new Error("Clawline interactive HTML descriptor exceeds maxInlineBytes");
          }
          throw new Error("Clawline inline document descriptor exceeds maxInlineBytes");
        }
        resolved.push({ type: "document", mimeType, data });
        continue;
      }
      const assetId = `a_${randomUUID()}`;
      const assetPath = path.join(assetsDir, assetId);
      await fs.writeFile(assetPath, buffer);
      await enqueueWriteTask(() =>
        insertAssetStmt.run(
          assetId,
          params.ownerUserId,
          mimeType,
          buffer.length,
          nowMs(),
          params.uploaderDeviceId,
        ),
      );
      resolved.push({ type: "asset", assetId });
      assetIds.push(assetId);
    }
    return { attachments: resolved, assetIds };
  }

  async function materializeOutboundMediaUrls(params: {
    mediaUrls: string[];
    ownerUserId: string;
    uploaderDeviceId: string;
  }): Promise<{ attachments: NormalizedAttachment[]; assetIds: string[] }> {
    if (params.mediaUrls.length === 0) {
      return { attachments: [], assetIds: [] };
    }
    const resolved: NormalizedAttachment[] = [];
    const assetIds: string[] = [];
    const trimmedUrls = params.mediaUrls
      .map((url) => (typeof url === "string" ? url.trim() : ""))
      .filter((url) => url.length > 0);
    for (const url of trimmedUrls) {
      const media = await fetchPinnedMedia(url, config.media.maxUploadBytes);
      if (media.buffer.length === 0) {
        continue;
      }
      const processed = await clampAndOptimizeMedia({
        buffer: media.buffer,
        contentType: media.contentType,
        fileName: media.fileName,
        maxBytes: config.media.maxUploadBytes,
      });
      const mimeType = (processed.contentType ?? "application/octet-stream").toLowerCase();
      const buffer = processed.buffer;
      const isInlineImage = INLINE_IMAGE_MIME_TYPES.has(mimeType);
      if (isInlineImage) {
        resolved.push({ type: "image", mimeType, data: buffer.toString("base64") });
        continue;
      }
      const assetId = `a_${randomUUID()}`;
      const assetPath = path.join(assetsDir, assetId);
      await fs.writeFile(assetPath, buffer);
      await enqueueWriteTask(() =>
        insertAssetStmt.run(
          assetId,
          params.ownerUserId,
          mimeType,
          buffer.length,
          nowMs(),
          params.uploaderDeviceId,
        ),
      );
      resolved.push({ type: "asset", assetId });
      assetIds.push(assetId);
    }
    return { attachments: resolved, assetIds };
  }

  async function materializeInlineAttachments(params: {
    attachments: NormalizedAttachment[];
    ownerUserId: string;
    deviceId: string;
  }): Promise<{ attachments: NormalizedAttachment[]; inlineAssetIds: string[] }> {
    const updated: NormalizedAttachment[] = [];
    const inlineAssetIds: string[] = [];
    for (const attachment of params.attachments) {
      if (attachment.type !== "image" || attachment.assetId) {
        updated.push(attachment);
        continue;
      }
      let buffer: Buffer;
      try {
        buffer = Buffer.from(attachment.data, "base64");
      } catch (err) {
        logger.warn?.(`[clawline] inline_attachment_decode_failed: ${formatError(err)}`);
        updated.push(attachment);
        continue;
      }
      if (buffer.length === 0) {
        updated.push(attachment);
        continue;
      }
      const assetId = `a_${randomUUID()}`;
      const assetPath = path.join(assetsDir, assetId);
      try {
        await fs.writeFile(assetPath, buffer);
        await enqueueWriteTask(() =>
          insertAssetStmt.run(
            assetId,
            params.ownerUserId,
            attachment.mimeType,
            buffer.length,
            nowMs(),
            params.deviceId,
          ),
        );
        inlineAssetIds.push(assetId);
        updated.push({ ...attachment, assetId });
      } catch (err) {
        logger.warn?.(`[clawline] inline_attachment_persist_failed: ${formatError(err)}`);
        updated.push(attachment);
      }
    }
    return { attachments: updated, inlineAssetIds };
  }

  async function ensureAssetOwnership(assetId: string, session: Session): Promise<string> {
    // Verify the asset exists and is owned by this user (no copying needed;
    // admins can access any asset via canAccessAsset)
    const asset = selectAssetStmt.get(assetId) as { assetId: string; userId: string } | undefined;
    if (!asset) {
      throw new ClientMessageError("asset_not_found", "Asset not found");
    }
    if (asset.userId !== session.userId) {
      throw new ClientMessageError("asset_not_found", "Asset not found");
    }
    return assetId;
  }

  async function ensureChannelAttachmentOwnership(params: {
    attachments: NormalizedAttachment[];
    assetIds: string[];
    session: Session;
  }): Promise<{ attachments: NormalizedAttachment[]; assetIds: string[] }> {
    // All channel types work the same: verify assets are owned by the session user.
    // (Ownership is also checked in insertUserMessageTx; this is an early validation.)
    for (const attachment of params.attachments) {
      if (attachment.type === "asset" && typeof attachment.assetId === "string") {
        await ensureAssetOwnership(attachment.assetId, params.session);
      }
    }
    return { attachments: params.attachments, assetIds: params.assetIds };
  }

  type EventRow = { id: string; payloadJson: string };

  const logHttpRequest = (event: string, info?: Record<string, unknown>) => {
    if (info) {
      logger.info?.(`[clawline:http] ${event}`, info);
    } else {
      logger.info?.(`[clawline:http] ${event}`);
    }
  };

  const httpServer = http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        logHttpRequest("request_missing_url", { method: req.method ?? "UNKNOWN" });
        res.writeHead(404).end();
        return;
      }
      const headerIncludes = (
        headerValue: string | string[] | undefined,
        needle: string,
      ): boolean => {
        if (typeof headerValue === "string") {
          return headerValue.toLowerCase().includes(needle);
        }
        if (Array.isArray(headerValue)) {
          return headerValue.some((value) => value.toLowerCase().includes(needle));
        }
        return false;
      };
      const isUpgradeRequest =
        headerIncludes(req.headers.upgrade, "websocket") &&
        headerIncludes(req.headers.connection, "upgrade");
      if (isUpgradeRequest) {
        // Let the upgrade handler take over without sending an HTTP response.
        logHttpRequest("request_upgrade_passthrough", {
          method: req.method ?? "UNKNOWN",
          path: req.url ?? "UNKNOWN",
        });
        return;
      }
      const parsedUrl = new URL(req.url, "http://localhost");
      logHttpRequest("request_received", {
        method: req.method ?? "UNKNOWN",
        path: parsedUrl.pathname,
      });
      if (req.method === "GET" && parsedUrl.pathname === "/version") {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ protocolVersion: PROTOCOL_VERSION }));
        logHttpRequest("request_handled", {
          method: req.method,
          path: parsedUrl.pathname,
          status: 200,
        });
        return;
      }
      if (req.method === "POST" && parsedUrl.pathname === "/upload") {
        logHttpRequest("upload_start");
        await handleUpload(req, res);
        logHttpRequest("upload_complete");
        return;
      }
      if (req.method === "GET" && parsedUrl.pathname.startsWith("/download/")) {
        const assetId = parsedUrl.pathname.slice("/download/".length);
        logHttpRequest("download_start", { assetId });
        await handleDownload(req, res, assetId);
        logHttpRequest("download_complete", { assetId });
        return;
      }
      if (parsedUrl.pathname === "/api/streams") {
        if (req.method === "GET") {
          await handleListStreamsRequest(req, res);
          return;
        }
        if (req.method === "POST") {
          await handleCreateStreamRequest(req, res);
          return;
        }
      }
      if (parsedUrl.pathname.startsWith("/api/streams/")) {
        if (req.method === "PATCH") {
          await handleRenameStreamRequest(req, res);
          return;
        }
        if (req.method === "DELETE") {
          await handleDeleteStreamRequest(req, res);
          return;
        }
      }
      if (
        parsedUrl.pathname === WEBROOT_PREFIX ||
        parsedUrl.pathname.startsWith(`${WEBROOT_PREFIX}/`)
      ) {
        await handleWebRootRequest(req, res, parsedUrl.pathname);
        return;
      }
      if (req.method === "POST" && parsedUrl.pathname === "/alert") {
        await handleAlertHttpRequest(req, res);
        return;
      }
      logHttpRequest("request_not_found", {
        method: req.method ?? "UNKNOWN",
        path: parsedUrl.pathname,
      });
      res.writeHead(404).end();
    } catch (err) {
      const pathName = req.url ? new URL(req.url, "http://localhost").pathname : "";
      const isStreamApi = pathName === "/api/streams" || pathName.startsWith("/api/streams/");
      if (isStreamApi) {
        if (err instanceof HttpError) {
          sendStreamApiError(res, err.status, err.code, err.message);
        } else {
          logger.error?.(`http_request_failed: ${formatError(err)}`);
          sendStreamApiError(res, 500, "server_error", "Internal error");
        }
        return;
      }
      logger.error?.(`http_request_failed: ${formatError(err)}`);
      if (!res.headersSent) {
        sendHttpError(res, 500, "server_error", "Internal error");
      } else {
        res.end();
      }
    }
  });

  async function handleWebRootRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
  ) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      sendHttpError(res, 405, "invalid_message", "Method not allowed on /www");
      return;
    }
    const rawRelative = pathname.slice(WEBROOT_PREFIX.length);
    let decodedRelative = "";
    try {
      decodedRelative = decodeURIComponent(rawRelative || "");
    } catch {
      sendHttpError(res, 400, "invalid_message", "Invalid path");
      return;
    }
    const trimmed = decodedRelative.replace(/^\/+/, "");
    const sanitizedSegments =
      trimmed.length === 0 ? [] : trimmed.split("/").filter((segment) => segment.length > 0);
    for (const segment of sanitizedSegments) {
      if (segment === "." || segment === ".." || segment.startsWith(".")) {
        sendHttpError(res, 404, "not_found", "File not found");
        return;
      }
    }
    const basePath = config.webRootPath;
    let targetPath =
      sanitizedSegments.length > 0 ? path.join(basePath, ...sanitizedSegments) : basePath;
    let fileStat: Stats;
    try {
      fileStat = await fs.stat(targetPath);
    } catch (err) {
      const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
      if (code === "ENOENT" || code === "ENOTDIR") {
        sendHttpError(res, 404, "not_found", "File not found");
        return;
      }
      logger.error?.(`[clawline] webroot_stat_failed: ${formatError(err)}`);
      sendHttpError(res, 500, "server_error", "Failed to read static file");
      return;
    }
    let finalPath = targetPath;
    if (fileStat.isDirectory()) {
      const indexPath = path.join(targetPath, "index.html");
      try {
        const indexStat = await fs.stat(indexPath);
        if (!indexStat.isFile()) {
          sendHttpError(res, 404, "not_found", "File not found");
          return;
        }
        fileStat = indexStat;
        finalPath = indexPath;
      } catch (err) {
        const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
        if (code === "ENOENT" || code === "ENOTDIR") {
          sendHttpError(res, 404, "not_found", "File not found");
          return;
        }
        logger.error?.(`[clawline] webroot_index_failed: ${formatError(err)}`);
        sendHttpError(res, 500, "server_error", "Failed to read static file");
        return;
      }
    } else if (!fileStat.isFile()) {
      sendHttpError(res, 404, "not_found", "File not found");
      return;
    }
    let finalRealPath: string;
    try {
      finalRealPath = await fs.realpath(finalPath);
    } catch (err) {
      logger.error?.(`[clawline] webroot_realpath_failed: ${formatError(err)}`);
      sendHttpError(res, 500, "server_error", "Failed to read static file");
      return;
    }
    if (config.webRoot.followSymlinks) {
      // Keep "no dotfiles" invariant even if a symlink points at a dotfile. Do not reject
      // dot-directories in the real path because webRootPath is configurable and may live under
      // paths like ~/.openclaw/...
      if (path.basename(finalRealPath).startsWith(".")) {
        sendHttpError(res, 404, "not_found", "File not found");
        return;
      }
    } else if (finalRealPath !== webRootRealPath && !finalRealPath.startsWith(webRootRealPrefix)) {
      // Default behavior: block symlink escapes (realpath follows symlinks).
      sendHttpError(res, 404, "not_found", "File not found");
      return;
    }
    const contentType = finalPath.toLowerCase().endsWith(".html")
      ? "text/html"
      : "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", fileStat.size.toString());
    res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=30");
    res.setHeader("Expires", new Date(Date.now() + 60_000).toUTCString());
    res.setHeader("Last-Modified", new Date(fileStat.mtimeMs).toUTCString());
    res.writeHead(200);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stream = createReadStream(finalPath);
    stream.on("error", (err) => {
      logger.error?.(`[clawline] webroot_stream_failed: ${formatError(err)}`);
      if (!res.headersSent) {
        sendHttpError(res, 500, "server_error", "Failed to stream file");
      } else {
        res.end();
      }
    });
    stream.pipe(res);
  }

  async function handleAlertHttpRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    logHttpRequest("alert_request_start");
    try {
      const payload = await parseAlertPayload(req);
      logger.info?.("[clawline] alert_received", {
        source: payload.source,
        hasSessionKey: Boolean(payload.sessionKey),
      });
      logger.info?.("[clawline] alert_payload_received", {
        bytes: Buffer.byteLength(payload.raw, "utf8"),
        sessionKey: payload.sessionKey ?? "undefined",
      });
      let text = buildAlertText(payload.message, payload.source);
      const alertResolution = resolveAlertSessionKey(payload.sessionKey);
      const pendingEvents = peekSystemEvents(alertResolution.resolvedSessionKey);
      const hasExecCompletion = pendingEvents.some((event) => event.includes("Exec finished"));
      if (hasExecCompletion) {
        text = `${EXEC_COMPLETION_ALERT_PROMPT}\n\n${text}`;
      }
      // Apply alert instructions last so they stay at the end and include the exec prompt in size checks.
      text = await applyAlertInstructions(text);
      await wakeGatewayForAlert(text, payload.sessionKey);
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      logHttpRequest("alert_request_complete");
    } catch (err) {
      if (err instanceof HttpError) {
        logHttpRequest("alert_request_error", { status: err.status, code: err.code });
        sendHttpError(res, err.status, err.code, err.message);
      } else {
        logger.error?.(`alert_request_failed: ${formatError(err)}`);
        sendHttpError(res, 500, "server_error", "Internal error");
      }
    }
  }

  async function parseAlertPayload(
    req: http.IncomingMessage,
  ): Promise<{ raw: string; message: string; source?: string; sessionKey?: string }> {
    const raw = await readRequestBody(req, MAX_ALERT_BODY_BYTES);
    if (raw.length === 0) {
      throw new HttpError(400, "invalid_request", "Empty alert payload");
    }
    const rawText = raw.toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new HttpError(400, "invalid_json", "Alert payload must be valid JSON");
    }
    if (!parsed || typeof parsed !== "object") {
      throw new HttpError(400, "invalid_request", "Alert payload must be an object");
    }
    const obj = parsed as Record<string, unknown>;
    const message = typeof obj.message === "string" ? obj.message : "";
    const source = typeof obj.source === "string" ? obj.source : undefined;
    const sessionKey = typeof obj.sessionKey === "string" ? obj.sessionKey : undefined;
    if (!message.trim()) {
      throw new HttpError(400, "invalid_message", "Alert message is required");
    }
    return { raw: rawText, message, source, sessionKey };
  }

  async function readRequestBody(
    req: http.IncomingMessage,
    limit: number,
    tooLargeMessage = "Alert payload too large",
  ): Promise<Buffer> {
    return await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const cleanup = () => {
        req.off("data", handleData);
        req.off("end", handleEnd);
        req.off("error", handleError);
      };
      const handleError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const handleEnd = () => {
        cleanup();
        resolve(Buffer.concat(chunks));
      };
      const handleData = (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          cleanup();
          chunks.length = 0;
          req.destroy();
          reject(new HttpError(413, "payload_too_large", tooLargeMessage));
          return;
        }
        chunks.push(chunk);
      };
      req.on("data", handleData);
      req.on("end", handleEnd);
      req.on("error", handleError);
    });
  }

  function buildAlertText(message: string, source?: string): string {
    const normalizedMessage = normalizeAlertMessage(message);
    if (!normalizedMessage) {
      throw new HttpError(400, "invalid_message", "Alert message is required");
    }
    const normalizedSource = resolveAlertSource(source);
    const text = normalizedSource
      ? `[${normalizedSource}] ${normalizedMessage}`
      : normalizedMessage;
    if (Buffer.byteLength(text, "utf8") > config.sessions.maxMessageBytes) {
      throw new HttpError(400, "message_too_large", "Alert message exceeds max size");
    }
    return text;
  }

  function normalizeAlertMessage(value: string): string | null {
    const cleaned = value.replace(CONTROL_CHARS_REGEX, "").trim();
    if (!cleaned) {
      return null;
    }
    return cleaned;
  }

  function resolveAlertSource(source?: string): string | undefined {
    const cleaned = source ? sanitizeLabel(source) : undefined;
    return cleaned ?? DEFAULT_ALERT_SOURCE;
  }

  function isRedirectStatus(status: number): boolean {
    return REDIRECT_STATUS_CODES.has(status);
  }

  function stripQuotes(value: string): string {
    return value.replace(/^["']|["']$/g, "");
  }

  function parseContentDispositionFileName(header?: string | null): string | undefined {
    if (!header) {
      return undefined;
    }
    const starMatch = /filename\*\s*=\s*([^;]+)/i.exec(header);
    if (starMatch?.[1]) {
      const cleaned = stripQuotes(starMatch[1].trim());
      const encoded = cleaned.split("''").slice(1).join("''") || cleaned;
      try {
        return path.basename(decodeURIComponent(encoded));
      } catch {
        return path.basename(encoded);
      }
    }
    const match = /filename\s*=\s*([^;]+)/i.exec(header);
    if (match?.[1]) {
      return path.basename(stripQuotes(match[1].trim()));
    }
    return undefined;
  }

  async function readResponseWithLimit(res: Response, maxBytes: number): Promise<Buffer> {
    const body = res.body;
    if (!body || typeof body.getReader !== "function") {
      const fallback = Buffer.from(await res.arrayBuffer());
      if (fallback.length > maxBytes) {
        throw new ClientMessageError(
          "payload_too_large",
          `mediaUrl payload exceeds maxBytes ${maxBytes}`,
        );
      }
      return fallback;
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value?.length) {
          total += value.length;
          if (total > maxBytes) {
            try {
              await reader.cancel();
            } catch {}
            throw new ClientMessageError(
              "payload_too_large",
              `mediaUrl payload exceeds maxBytes ${maxBytes}`,
            );
          }
          chunks.push(value);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }
    return Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      total,
    );
  }

  async function validateOutboundMediaUrl(
    rawUrl: string,
  ): Promise<{ url: string; pinned: PinnedHostname }> {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new ClientMessageError("invalid_message", "Invalid mediaUrl");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ClientMessageError("invalid_message", "Unsupported mediaUrl protocol");
    }
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "localhost" || hostname.endsWith(".localhost")) {
      throw new ClientMessageError("invalid_message", "mediaUrl points to localhost");
    }
    let pinned;
    try {
      pinned = await resolvePinnedHostname(hostname);
    } catch {
      throw new ClientMessageError(
        "invalid_message",
        "mediaUrl hostname could not be resolved or is blocked",
      );
    }
    return { url: parsed.toString(), pinned };
  }

  async function fetchPinnedMedia(
    rawUrl: string,
    maxBytes: number,
  ): Promise<{ buffer: Buffer; contentType?: string; fileName?: string }> {
    let currentUrl = rawUrl;
    let redirectCount = 0;

    while (true) {
      const validated = await validateOutboundMediaUrl(currentUrl);
      const dispatcher = createPinnedDispatcher(validated.pinned);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), MEDIA_FETCH_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(validated.url, {
          dispatcher,
          signal: controller.signal,
          redirect: "manual",
        } as RequestInit & { dispatcher: Dispatcher });
      } catch (err) {
        clearTimeout(timeoutId);
        await closeDispatcher(dispatcher);
        throw err;
      }

      if (isRedirectStatus(res.status)) {
        const location = res.headers.get("location");
        if (!location) {
          clearTimeout(timeoutId);
          await closeDispatcher(dispatcher);
          throw new ClientMessageError("invalid_message", "mediaUrl redirect missing location");
        }
        if (res.body) {
          try {
            await res.body.cancel();
          } catch {}
        }
        clearTimeout(timeoutId);
        await closeDispatcher(dispatcher);
        redirectCount += 1;
        if (redirectCount > MAX_MEDIA_REDIRECTS) {
          throw new ClientMessageError("invalid_message", "mediaUrl redirects too many times");
        }
        currentUrl = new URL(location, validated.url).toString();
        continue;
      }

      if (!res.ok) {
        clearTimeout(timeoutId);
        await closeDispatcher(dispatcher);
        throw new ClientMessageError(
          "invalid_message",
          `mediaUrl fetch failed (HTTP ${res.status})`,
        );
      }

      const contentLength = res.headers.get("content-length");
      if (contentLength) {
        const length = Number(contentLength);
        if (Number.isFinite(length) && length > maxBytes) {
          clearTimeout(timeoutId);
          await closeDispatcher(dispatcher);
          throw new ClientMessageError(
            "payload_too_large",
            `mediaUrl payload exceeds maxBytes ${maxBytes}`,
          );
        }
      }

      let buffer: Buffer;
      try {
        buffer = await readResponseWithLimit(res, maxBytes);
      } finally {
        clearTimeout(timeoutId);
        await closeDispatcher(dispatcher);
      }

      const headerFileName = parseContentDispositionFileName(
        res.headers.get("content-disposition"),
      );
      let fileNameFromUrl: string | undefined;
      try {
        const parsed = new URL(validated.url);
        const base = path.basename(parsed.pathname);
        fileNameFromUrl = base || undefined;
      } catch {
        fileNameFromUrl = undefined;
      }
      return {
        buffer,
        contentType: res.headers.get("content-type") ?? undefined,
        fileName: headerFileName || fileNameFromUrl,
      };
    }
  }

  async function clampAndOptimizeMedia(params: {
    buffer: Buffer;
    contentType?: string;
    fileName?: string;
    maxBytes: number;
  }): Promise<{ buffer: Buffer; contentType?: string }> {
    const { buffer, contentType, fileName, maxBytes } = params;
    const detected = await detectMime({
      buffer,
      headerMime: contentType,
      filePath: fileName,
    });
    const kind = detected ? mediaKindFromMime(detected) : undefined;
    const cap = maxBytes ?? (kind ? maxBytesForKind(kind) : maxBytes);
    if (kind !== "image") {
      if (buffer.length > cap) {
        throw new ClientMessageError(
          "payload_too_large",
          `mediaUrl payload exceeds maxBytes ${cap}`,
        );
      }
      return { buffer, contentType: detected ?? contentType };
    }
    const isGif = detected === "image/gif";
    if (isGif) {
      if (buffer.length > cap) {
        throw new ClientMessageError(
          "payload_too_large",
          `mediaUrl payload exceeds maxBytes ${cap}`,
        );
      }
      return { buffer, contentType: detected ?? contentType };
    }
    const isPng = detected === "image/png" || fileName?.toLowerCase().endsWith(".png");
    if (isPng) {
      try {
        const hasAlpha = await hasAlphaChannel(buffer);
        if (hasAlpha) {
          const optimized = await optimizeImageToPng(buffer, cap);
          if (optimized.buffer.length <= cap) {
            return { buffer: optimized.buffer, contentType: "image/png" };
          }
        }
      } catch {}
    }
    const optimized = await optimizeImageToJpeg(buffer, cap, { contentType, fileName });
    if (optimized.buffer.length > cap) {
      throw new ClientMessageError("payload_too_large", `mediaUrl payload exceeds maxBytes ${cap}`);
    }
    return { buffer: optimized.buffer, contentType: "image/jpeg" };
  }

  async function applyAlertInstructions(text: string): Promise<string> {
    const instructions = await readAlertInstructionsFromDisk();
    if (!instructions) {
      return text;
    }
    const combined = `${text}\n\n${instructions}`;
    if (Buffer.byteLength(combined, "utf8") > config.sessions.maxMessageBytes) {
      logger.warn?.("alert_instructions_skipped", {
        reason: "message_too_large",
        textBytes: Buffer.byteLength(text, "utf8"),
        instructionsBytes: Buffer.byteLength(instructions, "utf8"),
      });
      return text;
    }
    return combined;
  }

  async function readAlertInstructionsFromDisk(): Promise<string | null> {
    if (!alertInstructionsPath) {
      return null;
    }
    try {
      const raw = await fs.readFile(alertInstructionsPath, "utf8");
      const trimmed = raw.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch (err) {
      const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
      if (code && code !== "ENOENT") {
        logger.warn?.(`alert_instructions_read_failed: ${formatError(err)}`);
      }
      return null;
    }
  }

  async function ensureAlertInstructionsFileIfMissing() {
    if (!alertInstructionsPath) {
      return;
    }
    try {
      await fs.access(alertInstructionsPath);
    } catch (err) {
      const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
      if (code && code !== "ENOENT") {
        logger.warn?.(`alert_instructions_access_failed: ${formatError(err)}`);
        return;
      }
      try {
        await ensureDir(path.dirname(alertInstructionsPath));
        await fs.writeFile(alertInstructionsPath, `${DEFAULT_ALERT_INSTRUCTIONS_TEXT}\n`, "utf8");
        logger.info?.("alert_instructions_initialized", { alertInstructionsPath });
      } catch (writeErr) {
        logger.warn?.(`alert_instructions_write_failed: ${formatError(writeErr)}`);
      }
    }
  }

  function isValidAlertSessionKey(value?: string) {
    if (!value) {
      return false;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return false;
    }
    if (trimmed === "global") {
      return true;
    }
    return (
      /^agent:[^:]+:main$/i.test(trimmed) ||
      /^agent:[^:]+:clawline:[^:]+:main$/i.test(trimmed) ||
      /^agent:[^:]+:clawline:dm:[^:]+$/i.test(trimmed)
    );
  }

  function resolveAlertSessionKey(rawSessionKey?: string) {
    const trimmedSessionKey = rawSessionKey?.trim() ?? "";
    const isValid = isValidAlertSessionKey(trimmedSessionKey);
    let resolvedSessionKey = mainSessionKey;
    let decisionReason = "missing_session_key";
    let decisionAction = "fallback_main_session";

    if (typeof rawSessionKey === "string") {
      if (trimmedSessionKey.length === 0) {
        decisionReason = "empty_session_key";
      } else if (isValid) {
        const normalized = trimmedSessionKey.toLowerCase();
        if (normalized === normalizedMainKey) {
          resolvedSessionKey = mainSessionKey;
        } else {
          resolvedSessionKey = trimmedSessionKey;
        }
        decisionReason = "valid_session_key";
        decisionAction = "use_provided_session_key";
      } else {
        decisionReason = "invalid_session_key";
      }
    }

    return {
      trimmedSessionKey,
      isValid,
      resolvedSessionKey,
      decisionReason,
      decisionAction,
    };
  }

  async function wakeGatewayForAlert(text: string, sessionKey?: string) {
    try {
      const rawSessionKey = typeof sessionKey === "string" ? sessionKey : undefined;
      const { trimmedSessionKey, isValid, resolvedSessionKey, decisionReason, decisionAction } =
        resolveAlertSessionKey(rawSessionKey);

      logger.info?.(
        `[clawline] alert_session_key_decision raw=${rawSessionKey ?? "undefined"} trimmed=${trimmedSessionKey || "undefined"} valid=${isValid} action=${decisionAction} reason=${decisionReason} resolved=${resolvedSessionKey}`,
      );
      if (decisionReason === "invalid_session_key") {
        logger.warn?.("alert_session_key_invalid", { sessionKey: rawSessionKey });
      }

      const alertLog = (event: string, detail?: Record<string, unknown>) =>
        logger.info?.(`[clawline] ${event}`, {
          ...detail,
          sessionKey: resolvedSessionKey,
        });

      alertLog("alert_wake_start");

      const queueSettings = resolveQueueSettings({ cfg: openClawCfg });
      const sendQueuedAlert = async (item: AnnounceQueueItem) => {
        const origin = item.origin;
        const threadId =
          origin?.threadId != null && origin.threadId !== "" ? String(origin.threadId) : undefined;
        await callGateway({
          method: "agent",
          params: {
            sessionKey: item.sessionKey,
            message: item.prompt,
            channel: origin?.channel,
            accountId: origin?.accountId,
            to: origin?.to,
            threadId,
            deliver: true,
            idempotencyKey: randomUUID(),
          },
          expectFinal: true,
          timeoutMs: 60_000,
        });
      };

      // Always enqueue — never send directly to the agent, even if it appears idle.
      // The gateway has no session-level locking. isEmbeddedPiRunActive has a race window:
      // the agent turn can finish writing JSONL but not yet clear the active-runs Map,
      // so a 'direct' send can hit the JSONL lock and timeout, losing the message.
      // Enqueuing unconditionally eliminates this race. The queue drains when the agent
      // is truly idle. The latency cost is negligible vs message loss.
      // Explicit origin prevents core fallback to lastTo (which could target a different session).
      const alertOrigin =
        resolvedSessionKey.trim().toLowerCase() === "global"
          ? undefined
          : { channel: "clawline", to: resolvedSessionKey };
      enqueueAnnounce({
        key: resolvedSessionKey,
        item: {
          prompt: `System Alert: ${text}`,
          summaryLine: "System Alert",
          enqueuedAt: Date.now(),
          sessionKey: resolvedSessionKey,
          origin: alertOrigin,
        },
        settings: queueSettings,
        send: sendQueuedAlert,
      });

      alertLog("alert_wake_result", { outcome: "queued" });
    } catch (err) {
      logger.error?.(`alert_gateway_wake_failed: ${formatError(err)}`);
      throw err instanceof HttpError
        ? err
        : new HttpError(502, "wake_failed", "Failed to wake CLU");
    }
  }

  const sockets = new Set<net.Socket>();
  httpServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const maxPayload = Math.max(
    config.sessions.maxMessageBytes + config.media.maxInlineBytes,
    256 * 1024,
  );
  const wss = new WebSocketServer({ noServer: true, maxPayload });
  const terminalWss = new WebSocketServer({ noServer: true, maxPayload });

  httpServer.on("upgrade", (request, socket, head) => {
    const origin = request.headers.origin ?? "null";
    logger.info?.("[clawline:http] ws_upgrade_received", {
      url: request.url,
      origin,
    });
    let server: WebSocketServer | null = null;
    if (request.url === "/ws") {
      server = wss;
    } else if (request.url === "/ws/terminal") {
      server = terminalWss;
    } else {
      logger.info?.("[clawline:http] ws_upgrade_rejected_path", { url: request.url });
      socket.destroy();
      return;
    }
    let originAllowed = true;
    if (config.network.allowedOrigins && config.network.allowedOrigins.length > 0) {
      originAllowed = config.network.allowedOrigins.includes(origin);
      logger.info?.("[clawline:http] ws_upgrade_origin_check", {
        origin,
        allowed: config.network.allowedOrigins,
        originAllowed,
      });
      if (!originAllowed) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
    } else {
      logger.info?.("[clawline:http] ws_upgrade_origin_check", {
        origin,
        allowed: "any",
        originAllowed,
      });
    }
    logger.info?.("[clawline:http] ws_upgrade_forward", { origin });
    server.handleUpgrade(request, socket, head, (ws) => {
      logger.info?.("[clawline:http] ws_handle_upgrade_complete", { origin });
      server.emit("connection", ws, request);
    });
  });

  const connectionState = new WeakMap<WebSocket, ConnectionState>();
  type TerminalConnectionState =
    | { authenticated: false }
    | {
        authenticated: true;
        deviceId: string;
        userId: string;
        terminalSessionId: string;
        tmuxSessionName: string;
        paneId: string;
        // node-pty has no great runtime type here; treat as opaque.
        // oxlint-disable-next-line typescript/no-explicit-any
        pty: any;
      };
  const terminalConnectionState = new WeakMap<WebSocket, TerminalConnectionState>();
  const terminalSessions = new Map<string, TerminalSessionRecord>();
  const TERMINAL_DB_LOOKUP_LIMIT = 300;
  const pendingSockets = new Map<string, PendingConnection>();
  const faceSpeakPending = new Map<string, string>();
  const faceSpeakDedupe = new Map<string, number>();
  const sessionsByDevice = new Map<string, Session>();
  const userSessions = new Map<string, Set<Session>>();
  const perUserTaskQueue = createPerUserTaskQueue({
    onTaskError: (err) => {
      logger.warn?.(`per_user_task_failed: ${formatError(err)}`);
    },
  });
  const pairRateLimiter = new SlidingWindowRateLimiter(config.pairing.maxRequestsPerMinute, 60_000);
  const authRateLimiter = new SlidingWindowRateLimiter(config.auth.maxAttemptsPerMinute, 60_000);
  const messageRateLimiter = new SlidingWindowRateLimiter(
    config.sessions.maxMessagesPerSecond,
    1_000,
  );
  let writeQueue: Promise<void> = Promise.resolve();
  let writeQueueDepth = 0;
  const pendingCleanupInterval = setInterval(() => expirePendingPairs(), 1_000);
  if (typeof pendingCleanupInterval.unref === "function") {
    pendingCleanupInterval.unref();
  }
  const maintenanceIntervalMs = Math.min(
    60_000,
    Math.max(1_000, config.media.unreferencedUploadTtlSeconds * 250),
  );
  const assetCleanupInterval =
    config.media.unreferencedUploadTtlSeconds > 0
      ? setInterval(() => {
          cleanupUnreferencedAssets().catch((err) =>
            logger.warn?.(`asset_cleanup_failed: ${formatError(err)}`),
          );
        }, maintenanceIntervalMs)
      : null;
  if (assetCleanupInterval && typeof assetCleanupInterval.unref === "function") {
    assetCleanupInterval.unref();
  }
  let allowlistWritePending = 0;
  const allowlistWatcher: FSWatcher = watch(allowlistPath, { persistent: false }, () => {
    if (allowlistWritePending > 0) {
      allowlistWritePending -= 1;
      return;
    }
    void refreshAllowlistFromDisk();
  });
  allowlistWatcher.on("error", (err) =>
    logger.warn?.(`allowlist_watch_failed: ${formatError(err)}`),
  );
  const pendingFileWatcher: FSWatcher = watch(pendingPath, { persistent: false }, () => {
    void refreshPendingFile();
  });
  pendingFileWatcher.on("error", (err) =>
    logger.warn?.(`pending_watch_failed: ${formatError(err)}`),
  );
  const denylistWatcher: FSWatcher = watch(denylistPath, { persistent: false }, () => {
    void refreshDenylist();
  });
  denylistWatcher.on("error", (err) => logger.warn?.(`denylist_watch_failed: ${formatError(err)}`));

  async function filterOutboundAttachmentsForTerminalPolicy(params: {
    attachments: NormalizedAttachment[];
    ownerUserId: string;
    sessionKey: string;
  }): Promise<NormalizedAttachment[]> {
    if (params.attachments.length === 0) {
      return params.attachments;
    }
    const terminalAllowed = isClawlinePersonalUserStreamSessionKey(
      params.sessionKey,
      params.ownerUserId,
    );
    const filtered: NormalizedAttachment[] = [];
    for (const attachment of params.attachments) {
      if (attachment.type === "document" && attachment.mimeType === TERMINAL_SESSION_MIME) {
        if (!terminalAllowed) {
          logger.warn?.("[clawline] terminal_attachment_blocked", {
            sessionKey: params.sessionKey,
            ownerUserId: params.ownerUserId,
          });
          throw new Error(
            "Terminal attachments are only allowed in per-user Clawline sessions (agent:<agentId>:clawline:<userId>:main|dm).",
          );
        }
        const descriptor = decodeTerminalSessionDescriptorFromBase64(attachment.data);
        if (!descriptor) {
          logger.warn?.("[clawline] terminal_attachment_invalid_descriptor", {
            sessionKey: params.sessionKey,
            ownerUserId: params.ownerUserId,
          });
          continue;
        }
        const now = nowMs();
        terminalSessions.set(descriptor.terminalSessionId, {
          terminalSessionId: descriptor.terminalSessionId,
          ownerUserId: params.ownerUserId,
          sessionKey: params.sessionKey,
          title: descriptor.title,
          createdAt: now,
          lastSeenAt: now,
          tmuxSessionName: descriptor.terminalSessionId,
        });
        filtered.push(attachment);
        continue;
      }
      filtered.push(attachment);
    }
    return filtered;
  }

  function lookupTerminalSessionRecordFromDb(params: {
    userId: string;
    terminalSessionId: string;
  }): { sessionKey: string; title?: string } | null {
    if (!selectEventsTailStmt) {
      return null;
    }
    const limit = TERMINAL_DB_LOOKUP_LIMIT;
    let rows: Array<{ id: string; payloadJson: string }> = [];
    try {
      rows = selectEventsTailStmt.all(params.userId, limit) as Array<{
        id: string;
        payloadJson: string;
      }>;
    } catch {
      return null;
    }
    for (const row of rows) {
      const msg = parseServerMessage(row.payloadJson, logger);
      if (!msg || msg.type !== "message" || !Array.isArray(msg.attachments)) {
        continue;
      }
      const sessionKey = typeof msg.sessionKey === "string" ? msg.sessionKey : "";
      if (!sessionKey || !isClawlinePersonalUserStreamSessionKey(sessionKey, params.userId)) {
        continue;
      }
      for (const attachment of msg.attachments) {
        if (!attachment || typeof attachment !== "object") {
          continue;
        }
        const a = attachment as { type?: unknown; mimeType?: unknown; data?: unknown };
        if (
          a.type !== "document" ||
          a.mimeType !== TERMINAL_SESSION_MIME ||
          typeof a.data !== "string"
        ) {
          continue;
        }
        const descriptor = decodeTerminalSessionDescriptorFromBase64(a.data);
        if (!descriptor || descriptor.terminalSessionId !== params.terminalSessionId) {
          continue;
        }
        return { sessionKey, title: descriptor.title || undefined };
      }
    }
    return null;
  }

  function runPerUserTask<T>(
    userId: string,
    task: () => Promise<T>,
    opts?: { streamKey?: string },
  ): Promise<T> {
    return perUserTaskQueue.run({ userId, streamKey: opts?.streamKey }, task);
  }

  function enqueueWriteTask<T>(task: () => T | Promise<T>): Promise<T> {
    if (writeQueueDepth >= config.sessions.maxWriteQueueDepth) {
      return Promise.reject(new Error("write_queue_full"));
    }
    writeQueueDepth += 1;
    const run = () => Promise.resolve().then(task);
    const result = writeQueue.then(run, run);
    writeQueue = result.then(
      () => undefined,
      (err) => {
        logger.warn?.(`write_queue_failed: ${formatError(err)}`);
        return undefined;
      },
    );
    return result.finally(() => {
      writeQueueDepth = Math.max(0, writeQueueDepth - 1);
    });
  }

  async function persistAllowlist() {
    allowlistWritePending += 1;
    await fs.writeFile(allowlistPath, JSON.stringify(allowlist, null, 2));
    handleAllowlistChanged();
  }

  async function persistPendingFile() {
    await fs.writeFile(pendingPath, JSON.stringify(pendingFile, null, 2));
  }

  async function refreshAllowlistFromDisk() {
    try {
      allowlist = await loadAllowlist(allowlistPath);
      allowlist.entries.forEach(normalizeAllowlistEntry);
      handleAllowlistChanged();
    } catch (err) {
      logger.warn?.(`allowlist_reload_failed: ${formatError(err)}`);
    }
  }

  async function refreshPendingFile() {
    try {
      pendingFile = await loadPending(pendingPath);
      reconcilePendingSocketsWithFile();
    } catch (err) {
      logger.warn?.(`pending_reload_failed: ${formatError(err)}`);
    }
  }

  async function refreshDenylist() {
    try {
      const next = await loadDenylist(denylistPath);
      const newlyRevoked = next.filter(
        (entry) => !denylist.some((existing) => existing.deviceId === entry.deviceId),
      );
      denylist = next;
      for (const revoked of newlyRevoked) {
        const session = sessionsByDevice.get(revoked.deviceId);
        if (session) {
          sendJson(session.socket, {
            type: "error",
            code: "token_revoked",
            message: "Device revoked",
          })
            .catch(() => {})
            .finally(() => session.socket.close(1008));
        }
      }
      for (const [deviceId, pending] of pendingSockets) {
        if (isDenylisted(deviceId)) {
          pendingSockets.delete(deviceId);
          void removePendingEntry(deviceId).catch(() => {});
          void sendJson(pending.socket, {
            type: "pair_result",
            success: false,
            reason: "pair_rejected",
          })
            .catch(() => {})
            .finally(() => pending.socket.close(1000));
        }
      }
    } catch (err) {
      logger.warn?.(`denylist_reload_failed: ${formatError(err)}`);
    }
  }

  function findAllowlistEntry(deviceId: string) {
    return allowlist.entries.find((entry) => entry.deviceId === deviceId);
  }

  function findPendingEntry(deviceId: string) {
    return pendingFile.entries.find((entry) => entry.deviceId === deviceId);
  }

  async function upsertPendingEntry(entry: PendingEntry) {
    const idx = pendingFile.entries.findIndex((existing) => existing.deviceId === entry.deviceId);
    if (idx >= 0) {
      pendingFile.entries[idx] = entry;
    } else {
      pendingFile.entries.push(entry);
    }
    await persistPendingFile();
  }

  async function removePendingEntry(deviceId: string) {
    const next = pendingFile.entries.filter((entry) => entry.deviceId !== deviceId);
    if (next.length === pendingFile.entries.length) {
      return;
    }
    pendingFile = { ...pendingFile, entries: next };
    await persistPendingFile();
  }

  function handleAllowlistChanged() {
    for (const deviceId of pendingSockets.keys()) {
      const entry = findAllowlistEntry(deviceId);
      if (entry) {
        void deliverPendingApproval(entry);
      }
    }

    for (const session of sessionsByDevice.values()) {
      const entry = findAllowlistEntry(session.deviceId);
      if (!entry) {
        continue;
      }
      if (session.isAdmin !== entry.isAdmin) {
        const info = applySessionInfo(session, entry.isAdmin);
        const state = connectionState.get(session.socket);
        if (state && state.authenticated) {
          state.isAdmin = entry.isAdmin;
        }
        const streams = filterStreamAccess(
          ensureStreamSessionsForUser({ userId: session.userId, isAdmin: entry.isAdmin }),
          entry.isAdmin,
        );
        syncUserSessionSubscriptions(session.userId, streams);
        void sendJson(session.socket, { type: "stream_snapshot", streams }).catch(() => {});
        void sendSessionInfo(session, info);
      }
    }
  }

  function reconcilePendingSocketsWithFile() {
    for (const [deviceId, pending] of pendingSockets) {
      if (findPendingEntry(deviceId)) {
        continue;
      }
      const allowlisted = findAllowlistEntry(deviceId);
      if (allowlisted) {
        void deliverPendingApproval(allowlisted);
        continue;
      }
      void sendJson(pending.socket, { type: "pair_result", success: false, reason: "pair_denied" })
        .catch(() => {})
        .finally(() => pending.socket.close(1000));
      pendingSockets.delete(deviceId);
    }
  }

  async function deliverPendingApproval(entry: AllowlistEntry) {
    const pending = pendingSockets.get(entry.deviceId);
    if (!pending) {
      return;
    }
    pendingSockets.delete(entry.deviceId);
    const token = issueToken(entry);
    const delivered = await sendJson(pending.socket, {
      type: "pair_result",
      success: true,
      token,
      userId: entry.userId,
    });
    if (delivered) {
      await setTokenDelivered(entry.deviceId, true);
    }
    pending.socket.close();
    await removePendingEntry(entry.deviceId).catch(() => {});
  }

  function isDenylisted(deviceId: string) {
    return denylist.some((entry) => entry.deviceId === deviceId);
  }

  function issueToken(entry: AllowlistEntry): string {
    const payload: jwt.JwtPayload = {
      sub: entry.userId,
      deviceId: entry.deviceId,
      isAdmin: entry.isAdmin,
      iat: Math.floor(Date.now() / 1000),
    };
    if (config.auth.tokenTtlSeconds != null && config.auth.tokenTtlSeconds > 0) {
      payload.exp = payload.iat! + config.auth.tokenTtlSeconds;
    }
    const token = jwt.sign(payload, jwtKey, { algorithm: "HS256" });
    return token;
  }

  async function setTokenDelivered(deviceId: string, delivered: boolean) {
    const entry = findAllowlistEntry(deviceId);
    if (!entry) {
      return;
    }
    entry.tokenDelivered = delivered;
    await persistAllowlist();
  }

  async function updateLastSeen(deviceId: string, timestamp: number) {
    const entry = findAllowlistEntry(deviceId);
    if (!entry) {
      return;
    }
    entry.lastSeenAt = timestamp;
    await persistAllowlist();
  }

  function sendJson(ws: WebSocket, payload: unknown): Promise<boolean> {
    return new Promise((resolve) => {
      if (ws.readyState !== WebSocket.OPEN) {
        logger.warn?.("[clawline:http] send_json_socket_not_open");
        resolve(false);
        return;
      }
      ws.send(JSON.stringify(payload), (err) => {
        if (err) {
          logger.warn?.(`[clawline:http] send_json_failed: ${formatError(err)}`);
          resolve(false);
          return;
        }
        resolve(true);
      });
    });
  }

  function markAckSent(deviceId: string, clientId: string) {
    updateMessageAckStmt.run(deviceId, clientId);
  }

  function sendHttpError(res: http.ServerResponse, status: number, code: string, message: string) {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(status);
    res.end(JSON.stringify({ type: "error", code, message }));
  }

  function sendStreamApiError(
    res: http.ServerResponse,
    status: number,
    code: string,
    message: string,
  ) {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(status);
    res.end(JSON.stringify({ error: { code, message } }));
  }

  function normalizeStreamMutationSessionKeyForUser(userId: string, sessionKey: string): string {
    // Mutation paths must never fall back to a default stream key.
    // If the path key is malformed, return not-found semantics.
    const normalized = normalizeStoredSessionKey(sessionKey);
    if (!normalized) {
      return "";
    }
    if (sessionKeyEq(normalized, mainSessionKey)) {
      return mainSessionKey;
    }
    const parsed = parseClawlineUserSessionKey(normalized);
    if (!parsed) {
      return "";
    }
    if (parsed.userId !== sanitizeUserId(userId).toLowerCase()) {
      return "";
    }
    if (
      parsed.streamSuffix !== "main" &&
      parsed.streamSuffix !== "dm" &&
      !isCustomStreamSuffix(parsed.streamSuffix)
    ) {
      return "";
    }
    return normalized;
  }

  function streamMutationRequestKey(operation: string, payload: Record<string, unknown>): string {
    return JSON.stringify({ operation, payload });
  }

  function authenticateHttpRequest(req: http.IncomingMessage) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      throw new HttpError(401, "auth_failed", "Missing authorization");
    }
    const token = header.slice(7).trim();
    if (!token) {
      throw new HttpError(401, "auth_failed", "Missing token");
    }
    let decoded: jwt.JwtPayload;
    try {
      decoded = jwt.verify(token, jwtKey, { algorithms: ["HS256"] }) as jwt.JwtPayload;
    } catch {
      throw new HttpError(401, "auth_failed", "Invalid token");
    }
    const deviceId = decoded.deviceId;
    if (typeof deviceId !== "string" || !validateDeviceId(deviceId)) {
      throw new HttpError(401, "auth_failed", "Invalid token device");
    }
    if (isDenylisted(deviceId)) {
      throw new HttpError(403, "token_revoked", "Device revoked");
    }
    const entry = findAllowlistEntry(deviceId);
    if (!entry) {
      throw new HttpError(401, "auth_failed", "Unknown device");
    }
    if (typeof decoded.sub !== "string" || !timingSafeStringEqual(decoded.sub, entry.userId)) {
      throw new HttpError(401, "auth_failed", "Invalid token subject");
    }
    return { deviceId, userId: entry.userId, isAdmin: entry.isAdmin };
  }

  async function ensureStreamsForAuthedUser(auth: {
    userId: string;
    isAdmin: boolean;
  }): Promise<StreamSession[]> {
    return runPerUserTask(auth.userId, async () =>
      enqueueWriteTask(() => {
        const streams = ensureStreamSessionsForUser({ userId: auth.userId, isAdmin: auth.isAdmin });
        syncUserSessionSubscriptions(auth.userId, streams);
        return filterStreamAccess(streams, auth.isAdmin);
      }),
    );
  }

  function loadStreamRowForUser(userId: string, sessionKey: string): StreamSessionRow | null {
    const row = selectStreamSessionByKeyStmt.get(userId, sessionKey) as
      | StreamSessionRow
      | undefined;
    return row ?? null;
  }

  function cleanupExpiredStreamIdempotencyRows() {
    deleteExpiredStreamIdempotencyStmt.run(nowMs() - STREAM_IDEMPOTENCY_RETENTION_MS);
  }

  function readIdempotencyRecord(params: {
    userId: string;
    idempotencyKey: string;
    operation: string;
    requestKey: string;
  }): { status: number; response: Record<string, unknown> } | null {
    const row = selectStreamIdempotencyStmt.get(params.userId, params.idempotencyKey) as
      | { operation: string; responseJson: string }
      | undefined;
    if (!row) {
      return null;
    }
    let parsed: StreamMutationIdempotencyRecord | null = null;
    try {
      parsed = JSON.parse(row.responseJson) as StreamMutationIdempotencyRecord;
    } catch {
      parsed = null;
    }
    if (!parsed) {
      throw new HttpError(409, "idempotency_key_reused", "Idempotency key was already used");
    }
    if (row.operation !== params.operation || parsed.requestKey !== params.requestKey) {
      throw new HttpError(409, "idempotency_key_reused", "Idempotency key was already used");
    }
    return { status: parsed.status, response: parsed.response };
  }

  function storeIdempotencyRecord(params: {
    userId: string;
    idempotencyKey: string;
    operation: string;
    requestKey: string;
    status: number;
    response: Record<string, unknown>;
  }) {
    const payload: StreamMutationIdempotencyRecord = {
      status: params.status,
      requestKey: params.requestKey,
      response: params.response,
    };
    insertStreamIdempotencyStmt.run(
      params.userId,
      params.idempotencyKey,
      params.operation,
      JSON.stringify(payload),
      nowMs(),
    );
  }

  async function broadcastStreamEvent(userId: string, payload: StreamServerMessage) {
    const sessions = userSessions.get(userId);
    if (!sessions || sessions.size === 0) {
      return;
    }
    const sends: Promise<boolean>[] = [];
    for (const session of sessions) {
      sends.push(sendJson(session.socket, payload));
    }
    await Promise.allSettled(sends);
  }

  async function handleListStreamsRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const auth = authenticateHttpRequest(req);
    const streams = await ensureStreamsForAuthedUser(auth);
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ streams }));
  }

  async function parseStreamsRequestBody(
    req: http.IncomingMessage,
  ): Promise<Record<string, unknown>> {
    const raw = await readRequestBody(req, MAX_STREAMS_BODY_BYTES, "Stream payload too large");
    if (raw.length === 0) {
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new HttpError(400, "invalid_json", "Stream payload must be valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "invalid_request", "Stream payload must be an object");
    }
    return parsed as Record<string, unknown>;
  }

  function parseSessionKeyPath(pathname: string): string {
    const prefix = "/api/streams/";
    if (!pathname.startsWith(prefix)) {
      throw new HttpError(404, "stream_not_found", "Stream not found");
    }
    const raw = pathname.slice(prefix.length);
    if (!raw || raw.includes("/")) {
      throw new HttpError(404, "stream_not_found", "Stream not found");
    }
    try {
      // Some clients can double-encode path components (e.g. %3A -> %253A).
      // Decode a bounded number of passes so stream mutations remain compatible.
      let decoded = raw;
      for (let pass = 0; pass < STREAM_SESSION_KEY_PATH_DECODE_PASSES; pass += 1) {
        const next = decodeURIComponent(decoded);
        if (next === decoded) {
          break;
        }
        decoded = next;
      }
      const trimmed = decoded.trim();
      if (!trimmed || trimmed.includes("/")) {
        throw new HttpError(400, "invalid_session_key", "Invalid session key");
      }
      return trimmed;
    } catch (err) {
      if (err instanceof HttpError) {
        throw err;
      }
      throw new HttpError(400, "invalid_session_key", "Invalid session key");
    }
  }

  async function handleCreateStreamRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const auth = authenticateHttpRequest(req);
    const body = await parseStreamsRequestBody(req);
    const idempotencyKey =
      typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
    const displayName = sanitizeStreamDisplayName(
      body.displayName,
      config.streams.maxDisplayNameBytes,
    );
    if (!displayName) {
      throw new HttpError(400, "invalid_display_name", "Display name is required");
    }
    if (!idempotencyKey) {
      throw new HttpError(400, "invalid_request", "idempotencyKey is required");
    }
    const requestKey = streamMutationRequestKey(STREAM_OPERATION_CREATE, { displayName });
    const existingIdempotent = readIdempotencyRecord({
      userId: auth.userId,
      idempotencyKey,
      operation: STREAM_OPERATION_CREATE,
      requestKey,
    });
    if (existingIdempotent) {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(existingIdempotent.status);
      res.end(JSON.stringify(existingIdempotent.response));
      return;
    }
    const { stream, responseBody } = await runPerUserTask(auth.userId, async () =>
      enqueueWriteTask(() => {
        const availableStreams = ensureStreamSessionsForUser({
          userId: auth.userId,
          isAdmin: auth.isAdmin,
        });
        const visibleStreams = filterStreamAccess(availableStreams, auth.isAdmin);
        if (visibleStreams.length >= config.streams.maxStreamsPerUser) {
          throw new HttpError(409, "stream_limit_reached", "Stream limit reached");
        }
        const now = nowMs();
        const maxOrderRow = selectStreamMaxOrderStmt.get(auth.userId) as {
          maxOrder: number | null;
        };
        let nextOrder = (maxOrderRow?.maxOrder ?? -1) + 1;
        let nextSessionKey = "";
        for (let attempts = 0; attempts < 8; attempts += 1) {
          const suffix = generateCustomStreamSuffix();
          const candidate = buildClawlineUserStreamSessionKey(
            mainSessionAgentId,
            auth.userId,
            suffix,
          );
          const existing = loadStreamRowForUser(auth.userId, candidate);
          if (!existing) {
            nextSessionKey = candidate;
            break;
          }
        }
        if (!nextSessionKey) {
          throw new HttpError(500, "server_error", "Unable to allocate stream key");
        }
        let inserted = false;
        let lastOrderConflict = false;
        for (let attempts = 0; attempts < 2; attempts += 1) {
          lastOrderConflict = false;
          try {
            insertStreamSessionStmt.run(
              auth.userId,
              nextSessionKey,
              displayName,
              "custom",
              nextOrder,
              0,
              now,
              now,
            );
            inserted = true;
            break;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes("stream_sessions.userId, stream_sessions.orderIndex")) {
              lastOrderConflict = true;
              const recomputed = selectStreamMaxOrderStmt.get(auth.userId) as {
                maxOrder: number | null;
              };
              nextOrder = (recomputed?.maxOrder ?? -1) + 1;
              continue;
            }
            throw err;
          }
        }
        if (!inserted) {
          if (lastOrderConflict) {
            throw new HttpError(409, "stream_limit_reached", "Unable to allocate stream order");
          }
          throw new HttpError(500, "server_error", "Unable to create stream");
        }
        const row = loadStreamRowForUser(auth.userId, nextSessionKey);
        if (!row) {
          throw new HttpError(500, "server_error", "Created stream is missing");
        }
        const created = streamSessionFromRow(row);
        const synced = ensureStreamSessionsForUser({ userId: auth.userId, isAdmin: auth.isAdmin });
        syncUserSessionSubscriptions(auth.userId, synced);
        const response = { stream: created };
        storeIdempotencyRecord({
          userId: auth.userId,
          idempotencyKey,
          operation: STREAM_OPERATION_CREATE,
          requestKey,
          status: 201,
          response,
        });
        return { stream: created, responseBody: response };
      }),
    );
    await broadcastStreamEvent(auth.userId, { type: "stream_created", stream });
    res.setHeader("Content-Type", "application/json");
    res.writeHead(201);
    res.end(JSON.stringify(responseBody));
  }

  async function handleRenameStreamRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const auth = authenticateHttpRequest(req);
    const sessionKeyInput = parseSessionKeyPath(
      new URL(req.url ?? "", "http://localhost").pathname,
    );
    const sessionKey = normalizeStreamMutationSessionKeyForUser(auth.userId, sessionKeyInput);
    if (!sessionKey) {
      throw new HttpError(404, "stream_not_found", "Stream not found");
    }
    const body = await parseStreamsRequestBody(req);
    const displayName = sanitizeStreamDisplayName(
      body.displayName,
      config.streams.maxDisplayNameBytes,
    );
    if (!displayName) {
      throw new HttpError(400, "invalid_display_name", "Display name is required");
    }
    const stream = await runPerUserTask(auth.userId, async () =>
      enqueueWriteTask(() => {
        const streams = ensureStreamSessionsForUser({ userId: auth.userId, isAdmin: auth.isAdmin });
        syncUserSessionSubscriptions(auth.userId, streams);
        const existing = loadStreamRowForUser(auth.userId, sessionKey);
        if (!existing) {
          throw new HttpError(404, "stream_not_found", "Stream not found");
        }
        if (existing.isBuiltIn === 1) {
          throw new HttpError(
            409,
            "built_in_stream_rename_forbidden",
            "Built-in streams cannot be renamed",
          );
        }
        const now = nowMs();
        updateStreamSessionDisplayNameStmt.run(displayName, now, auth.userId, sessionKey);
        const updated = loadStreamRowForUser(auth.userId, sessionKey);
        if (!updated) {
          throw new HttpError(404, "stream_not_found", "Stream not found");
        }
        const mapped = streamSessionFromRow(updated);
        const synced = ensureStreamSessionsForUser({ userId: auth.userId, isAdmin: auth.isAdmin });
        syncUserSessionSubscriptions(auth.userId, synced);
        return mapped;
      }),
    );
    await broadcastStreamEvent(auth.userId, { type: "stream_updated", stream });
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ stream }));
  }

  async function handleDeleteStreamRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const auth = authenticateHttpRequest(req);
    const userActionHeaderRaw = req.headers["x-clawline-user-action"];
    const userActionHeader = Array.isArray(userActionHeaderRaw)
      ? userActionHeaderRaw[0]
      : userActionHeaderRaw;
    if (
      typeof userActionHeader === "string" &&
      userActionHeader.trim().length > 0 &&
      userActionHeader.trim().toLowerCase() !== "delete_stream"
    ) {
      throw new HttpError(
        409,
        "stream_delete_requires_user_action",
        "Stream delete requires explicit user action",
      );
    }
    const sessionKeyInput = parseSessionKeyPath(
      new URL(req.url ?? "", "http://localhost").pathname,
    );
    const sessionKey = normalizeStreamMutationSessionKeyForUser(auth.userId, sessionKeyInput);
    if (!sessionKey) {
      throw new HttpError(404, "stream_not_found", "Stream not found");
    }
    const body = await parseStreamsRequestBody(req);
    const idempotencyKey =
      typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
    const requestKey = streamMutationRequestKey(STREAM_OPERATION_DELETE, { sessionKey });
    if (idempotencyKey) {
      const existingIdempotent = readIdempotencyRecord({
        userId: auth.userId,
        idempotencyKey,
        operation: STREAM_OPERATION_DELETE,
        requestKey,
      });
      if (existingIdempotent) {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(existingIdempotent.status);
        res.end(JSON.stringify(existingIdempotent.response));
        return;
      }
    }
    const responseBody = await runPerUserTask(auth.userId, async () =>
      enqueueWriteTask(async () => {
        const streams = ensureStreamSessionsForUser({ userId: auth.userId, isAdmin: auth.isAdmin });
        const visibleStreams = filterStreamAccess(streams, auth.isAdmin);
        const existing = loadStreamRowForUser(auth.userId, sessionKey);
        if (!existing) {
          throw new HttpError(404, "stream_not_found", "Stream not found");
        }
        if (existing.isBuiltIn === 1) {
          throw new HttpError(
            409,
            "built_in_stream_delete_forbidden",
            "Built-in streams cannot be deleted",
          );
        }
        if (visibleStreams.length <= 1) {
          throw new HttpError(409, "last_stream_delete_forbidden", "Cannot delete the last stream");
        }
        const deletedAssetIds = deleteStreamDataTx({
          userId: auth.userId,
          sessionKey,
        }) as string[];
        for (const assetId of deletedAssetIds) {
          await safeUnlink(path.join(assetsDir, assetId));
        }
        const synced = ensureStreamSessionsForUser({ userId: auth.userId, isAdmin: auth.isAdmin });
        syncUserSessionSubscriptions(auth.userId, synced);
        const response = { deletedSessionKey: sessionKey };
        if (idempotencyKey) {
          storeIdempotencyRecord({
            userId: auth.userId,
            idempotencyKey,
            operation: STREAM_OPERATION_DELETE,
            requestKey,
            status: 200,
            response,
          });
        }
        return response;
      }),
    );
    await broadcastStreamEvent(auth.userId, { type: "stream_deleted", sessionKey });
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify(responseBody));
  }

  async function safeUnlink(filePath: string) {
    try {
      await fs.unlink(filePath);
    } catch (err) {
      const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
      if (!err || code === "ENOENT") {
        return;
      }
      logger.warn?.(`file_unlink_failed: ${formatError(err)}`);
    }
  }

  async function sendReplay(session: Session, lastMessageId: string | null) {
    // All messages are stored under the real userId; sessionKey determines routing.
    // Query once to get all messages for this user.
    const transcriptTargets: Array<{ userId: string }> = [{ userId: session.userId }];
    const expectedMainStreamSessionKey = buildClawlinePersonalSessionKey(
      mainSessionAgentId,
      session.userId,
    );
    const expectedGlobalSessionKey = mainSessionKey;
    const normalizedMainKey = mainSessionKey.toLowerCase();
    const normalizeEventRouting = (event: ServerMessage): void => {
      const rawSessionKey = typeof event.sessionKey === "string" ? event.sessionKey.trim() : "";
      const normalized = normalizeStoredSessionKey(rawSessionKey, session.userId);
      if (!normalized) {
        event.sessionKey = expectedMainStreamSessionKey;
        return;
      }
      if (sessionKeyEq(normalized, expectedGlobalSessionKey)) {
        event.sessionKey = expectedGlobalSessionKey;
        return;
      }
      event.sessionKey = normalized;
    };
    let anchor: { userId: string; sequence: number; timestamp: number } | null = null;
    if (lastMessageId) {
      const anchorRow = selectEventByIdStmt.get(lastMessageId) as
        | { id: string; userId: string; sequence: number; timestamp: number }
        | undefined;
      if (anchorRow) {
        anchor = {
          userId: anchorRow.userId,
          sequence: anchorRow.sequence,
          timestamp: anchorRow.timestamp,
        };
      }
    }
    // Debug logging for duplicate investigation
    logger.info("replay_start", {
      deviceId: session.deviceId,
      userId: session.userId,
      lastMessageId: lastMessageId ?? "(null)",
      anchorFound: !!anchor,
      anchorSequence: anchor?.sequence,
    });
    const combined: ServerMessage[] = [];
    for (const target of transcriptTargets) {
      let rows: EventRow[] = [];
      if (!anchor) {
        rows = selectEventsTailStmt.all(
          target.userId,
          config.sessions.maxReplayMessages,
        ) as EventRow[];
      } else if (target.userId === anchor.userId) {
        rows = selectEventsAfterStmt.all(target.userId, anchor.sequence) as EventRow[];
      } else {
        rows = selectEventsAfterTimestampStmt.all(target.userId, anchor.timestamp) as EventRow[];
      }
      const parsed = rows
        .map((row) => parseServerMessage(row.payloadJson, logger))
        .filter((event): event is ServerMessage => Boolean(event))
        .map((event) => {
          normalizeEventRouting(event);
          return event;
        });
      combined.push(...parsed);
    }
    combined.sort((a, b) => a.timestamp - b.timestamp);
    const limited =
      combined.length > config.sessions.maxReplayMessages
        ? combined.slice(combined.length - config.sessions.maxReplayMessages)
        : combined;
    const sessionInfo = buildSessionInfo(session.userId, session.isAdmin);
    const payload = {
      type: "auth_result",
      success: true,
      userId: session.userId,
      sessionId: session.sessionId,
      isAdmin: session.isAdmin,
      replayCount: limited.length,
      replayTruncated: combined.length > limited.length,
      historyReset: !lastMessageId,
      features: buildAuthResultFeatures(session),
      dmScope: sessionInfo.dmScope,
      sessionKeys: sessionInfo.subscribedSessionKeys,
    };
    const streams = await runPerUserTask(session.userId, async () =>
      enqueueWriteTask(() => {
        const seeded = ensureStreamSessionsForUser({
          userId: session.userId,
          isAdmin: session.isAdmin,
        });
        syncUserSessionSubscriptions(session.userId, seeded);
        return filterStreamAccess(seeded, session.isAdmin);
      }),
    );
    // Debug logging for duplicate investigation
    logger.info("replay_complete", {
      deviceId: session.deviceId,
      replayCount: limited.length,
      historyReset: payload.historyReset,
      firstEventId: limited[0]?.id,
      lastEventId: limited[limited.length - 1]?.id,
    });
    await sendJson(session.socket, payload).catch(() => {});
    await sendJson(session.socket, { type: "stream_snapshot", streams }).catch(() => {});
    await sendSessionInfo(session, sessionInfo);
    for (const event of limited) {
      const normalized = normalizePayloadForSession(session, event, mainSessionKey.toLowerCase());
      if (!normalized) {
        continue;
      }
      logger.info("replay_send", {
        deviceId: session.deviceId,
        userId: session.userId,
        messageId: normalized.id,
        sessionKey: normalized.sessionKey,
        streaming: normalized.streaming,
        attachmentCount: Array.isArray(normalized.attachments) ? normalized.attachments.length : 0,
        replay: true,
      });
      const stats = summarizeAttachmentStats(normalized.attachments);
      if (stats) {
        logger.info?.(
          `[clawline:http] ws_send_message attachmentCount=${stats.count} inlineBytes=${stats.inlineBytes} assetCount=${stats.assetCount} replay=true`,
          {
            deviceId: session.deviceId,
            userId: session.userId,
            messageId: normalized.id,
            attachmentCount: stats.count,
            inlineBytes: stats.inlineBytes,
            assetCount: stats.assetCount,
            streaming: normalized.streaming,
            replay: true,
          },
        );
      }
      await sendJson(session.socket, normalized).catch(() => {});
    }
  }

  function sendPayloadToSession(session: Session, payload: ServerMessage) {
    const normalized = normalizePayloadForSession(session, payload, mainSessionKey.toLowerCase());
    if (!normalized) {
      return;
    }
    if (session.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const stats = summarizeAttachmentStats(normalized.attachments);
    if (stats) {
      logger.info?.(
        `[clawline:http] ws_send_message attachmentCount=${stats.count} inlineBytes=${stats.inlineBytes} assetCount=${stats.assetCount} replay=false`,
        {
          deviceId: session.deviceId,
          userId: session.userId,
          messageId: normalized.id,
          attachmentCount: stats.count,
          inlineBytes: stats.inlineBytes,
          assetCount: stats.assetCount,
          streaming: normalized.streaming,
          replay: false,
        },
      );
    }
    session.socket.send(JSON.stringify(normalized), (err) => {
      if (err) {
        session.socket.close();
        return;
      }
      const role = normalized.role ?? "assistant";
      const streaming = Boolean(normalized.streaming);
      const sessionKey = normalized.sessionKey;
      const messageId = normalized.id;
      const payloadText = typeof normalized.content === "string" ? normalized.content : "";
      const payloadTextLen = payloadText.trim().length;
      const pendingKey = messageId || sessionKey || "";
      const logDecision = (decision: "skip" | "attempt", reason: string, textLen: number) => {
        logger.info?.(
          `[clawline] face_speak_decision role=${role} streaming=${streaming} textLen=${textLen} decision=${decision} reason=${reason}`,
          { sessionKey, messageId },
        );
      };
      if (role !== "assistant") {
        logDecision("skip", "non_assistant", payloadTextLen);
        return;
      }
      if (streaming) {
        if (pendingKey && payloadTextLen > 0) {
          faceSpeakPending.set(pendingKey, payloadText);
          // Map preserves insertion order; evict oldest entries.
          while (faceSpeakPending.size > FACE_SPEAK_PENDING_MAX) {
            const oldest = faceSpeakPending.keys().next().value;
            if (!oldest) {
              break;
            }
            faceSpeakPending.delete(oldest);
          }
        }
        logDecision("skip", "streaming", payloadTextLen);
        return;
      }
      let speakText = payloadText;
      if (!payloadTextLen && pendingKey) {
        const pendingText = faceSpeakPending.get(pendingKey);
        if (typeof pendingText === "string") {
          speakText = pendingText;
        }
      }
      if (pendingKey) {
        faceSpeakPending.delete(pendingKey);
      }
      const speakTextLen = speakText.trim().length;
      if (!speakTextLen) {
        logDecision("skip", "empty_text", speakTextLen);
        return;
      }
      const endpoint =
        typeof process.env.CLU_FACE_SPEAK_URL === "string"
          ? process.env.CLU_FACE_SPEAK_URL.trim()
          : "";
      if (!endpoint) {
        logDecision("skip", "missing_endpoint", speakTextLen);
        return;
      }
      // Prevent duplicate TTS when the same assistant message is delivered to multiple sessions.
      const now = nowMs();
      for (const [key, ts] of faceSpeakDedupe) {
        if (now - ts > FACE_SPEAK_DEDUPE_TTL_MS) {
          faceSpeakDedupe.delete(key);
        }
      }
      while (faceSpeakDedupe.size > FACE_SPEAK_DEDUPE_MAX) {
        const oldest = faceSpeakDedupe.keys().next().value;
        if (!oldest) {
          break;
        }
        faceSpeakDedupe.delete(oldest);
      }
      const dedupeKey = messageId ?? (speakTextLen > 0 ? `text:${sha256(speakText.trim())}` : "");
      if (dedupeKey) {
        const lastSeen = faceSpeakDedupe.get(dedupeKey);
        if (lastSeen !== undefined && now - lastSeen < FACE_SPEAK_DEDUPE_TTL_MS) {
          logDecision("skip", "dedupe", speakTextLen);
          return;
        }
        faceSpeakDedupe.set(dedupeKey, now);
      }
      logDecision("attempt", "ok", speakTextLen);
      triggerFaceSpeak(speakText, logger, { sessionKey, messageId }, endpoint);
    });
  }

  function broadcastToSessionKey(sessionKey: string, payload: ServerMessage) {
    if (!payload.sessionKey) {
      payload.sessionKey = sessionKey;
    }
    const normalizedKey = payload.sessionKey.toLowerCase();
    for (const target of sessionsByDevice.values()) {
      const keys = target.sessionKeys?.length ? target.sessionKeys : [target.sessionKey];
      if (!keys.some((key) => key.toLowerCase() === normalizedKey)) {
        continue;
      }
      sendPayloadToSession(target, payload);
    }
  }

  async function appendEvent(event: ServerMessage, userId: string, originatingDeviceId?: string) {
    return enqueueWriteTask(() => insertEventTx(event, userId, originatingDeviceId));
  }

  async function persistUserMessage(
    session: Session,
    targetUserId: string,
    messageId: string,
    content: string,
    attachments: NormalizedAttachment[],
    attachmentsHash: string,
    assetIds: string[],
    sessionKey: string,
  ): Promise<{ event: ServerMessage; sequence: number }> {
    const timestamp = nowMs();
    try {
      return await enqueueWriteTask(
        () =>
          insertUserMessageTx(
            session,
            targetUserId,
            messageId,
            content,
            timestamp,
            attachments,
            attachmentsHash,
            assetIds,
            sessionKey,
          ) as { event: ServerMessage; sequence: number },
      );
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : err && typeof err === "object"
            ? (err as { message?: unknown }).message
            : undefined;
      if (typeof message === "string" && message.includes("FOREIGN KEY")) {
        throw new ClientMessageError("asset_not_found", "Asset not found");
      }
      throw err;
    }
  }

  async function persistAssistantMessage(
    session: Session,
    targetUserId: string,
    content: string,
    sessionKey: string,
    attachments?: NormalizedAttachment[],
  ): Promise<ServerMessage> {
    const timestamp = nowMs();
    const filteredAttachments = attachments
      ? await filterOutboundAttachmentsForTerminalPolicy({
          attachments,
          ownerUserId: targetUserId,
          sessionKey,
        })
      : undefined;
    const event: ServerMessage = {
      type: "message",
      id: generateServerMessageId(),
      role: "assistant",
      sender: resolveAssistantSenderName(sessionKey),
      content,
      timestamp,
      streaming: false,
      sessionKey,
      attachments:
        filteredAttachments && filteredAttachments.length > 0 ? filteredAttachments : undefined,
    };
    await appendEvent(event, targetUserId);
    return event;
  }

  async function sendOutboundMessage(
    params: ClawlineOutboundSendParams,
  ): Promise<ClawlineOutboundSendResult> {
    const targetInput = typeof params.target === "string" ? params.target : "";
    if (!targetInput.trim()) {
      throw new Error("Delivering to clawline requires --to <userId|deviceId>");
    }
    const text = typeof params.text === "string" ? params.text : "";
    const rawAttachments = Array.isArray(params.attachments) ? params.attachments : [];
    const mediaUrl = typeof params.mediaUrl === "string" ? params.mediaUrl.trim() : "";
    if (!text.trim() && rawAttachments.length === 0 && !mediaUrl) {
      throw new Error("Delivering to clawline requires --message <text> or attachments");
    }
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > config.sessions.maxMessageBytes) {
      throw new Error("Clawline message exceeds max size");
    }

    const normalizedTargetInput = targetInput.trim();
    const lowerTargetInput = normalizedTargetInput.toLowerCase();
    let sessionKeyHint: string | undefined;
    let target: ReturnType<typeof resolveSendTarget>;

    // For core-driven delivery, `params.target` is `deliveryContext.to` (e.g., "flynn:main").
    // Treat that as a delivery target, not a raw userId.
    let deliveryTarget: ClawlineDeliveryTarget | undefined;
    if (
      !lowerTargetInput.startsWith("agent:") &&
      !lowerTargetInput.startsWith("user:") &&
      !lowerTargetInput.startsWith("device:")
    ) {
      try {
        const parsed = ClawlineDeliveryTarget.fromString(normalizedTargetInput);
        deliveryTarget = parsed;
      } catch {
        // Not a delivery target.
      }
    }

    if (lowerTargetInput.startsWith("agent:")) {
      sessionKeyHint = normalizedTargetInput;
      target = resolveSessionTargetFromSessionKey(normalizedTargetInput);
    } else if (deliveryTarget) {
      const suffix = deliveryTarget.sessionLabel();
      const userId = deliveryTarget.userId();
      target = resolveSendTarget(userId);
      if (suffix === "main") {
        sessionKeyHint = buildClawlinePersonalSessionKey(mainSessionAgentId, userId);
      } else if (suffix === "global") {
        sessionKeyHint = mainSessionKey;
      } else if (suffix === "dm") {
        sessionKeyHint = buildClawlineUserStreamSessionKey(mainSessionAgentId, userId, "dm");
      } else if (isCustomStreamSuffix(suffix)) {
        sessionKeyHint = buildClawlineUserStreamSessionKey(mainSessionAgentId, userId, suffix);
      }
    } else {
      target = resolveSendTarget(normalizedTargetInput);
    }

    const sessionKeyRaw = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
    const resolvedSessionKey =
      sessionKeyRaw ||
      sessionKeyHint ||
      // Boundary normalization: accept user/device targets, but use fully-qualified session keys
      // internally so all Clawline routing stays session-key-based.
      buildClawlinePersonalSessionKey(mainSessionAgentId, target.userId);
    const normalizedResolvedSessionKey = normalizeStreamMutationSessionKeyForUser(
      target.userId,
      resolvedSessionKey,
    );
    if (!normalizedResolvedSessionKey) {
      throw new Error("stream_not_found");
    }

    let outboundAttachments = {
      attachments: [] as NormalizedAttachment[],
      assetIds: [] as string[],
    };
    if (rawAttachments.length > 0) {
      outboundAttachments = await materializeOutboundAttachments({
        attachments: rawAttachments,
        ownerUserId: target.userId,
        uploaderDeviceId: target.kind === "device" ? target.deviceId : "server",
      });
    } else if (mediaUrl) {
      outboundAttachments = await materializeOutboundMediaUrls({
        mediaUrls: [mediaUrl],
        ownerUserId: target.userId,
        uploaderDeviceId: target.kind === "device" ? target.deviceId : "server",
      });
    }

    outboundAttachments.attachments = await filterOutboundAttachmentsForTerminalPolicy({
      attachments: outboundAttachments.attachments,
      ownerUserId: target.userId,
      sessionKey: resolvedSessionKey,
    });

    const event: ServerMessage = {
      type: "message",
      id: generateServerMessageId(),
      role: "assistant",
      sender: resolveAssistantSenderName(normalizedResolvedSessionKey),
      content: text,
      timestamp: nowMs(),
      streaming: false,
      sessionKey: normalizedResolvedSessionKey,
      attachments:
        outboundAttachments.attachments.length > 0 ? outboundAttachments.attachments : undefined,
    };
    // Do not route outbound sends through runPerUserTask: inbound processing holds that queue for
    // the entire agent turn, which can stall sendAttachment rich-bubble delivery until timeout.
    await enqueueWriteTask(() => {
      const targetIsAdmin = allowlist.entries.some(
        (entry) =>
          entry.isAdmin &&
          entry.userId.toLowerCase() === sanitizeUserId(target.userId).toLowerCase(),
      );
      const streams = ensureStreamSessionsForUser({
        userId: target.userId,
        isAdmin: targetIsAdmin,
      });
      if (
        !streams.some((stream) => sessionKeyEq(stream.sessionKey, normalizedResolvedSessionKey))
      ) {
        throw new Error("stream_not_found");
      }
      syncUserSessionSubscriptions(target.userId, streams);
      insertEventTx(event, target.userId);
    });
    broadcastToSessionKey(normalizedResolvedSessionKey, event);
    return {
      messageId: event.id,
      userId: target.userId,
      deviceId: target.kind === "device" ? target.deviceId : undefined,
      attachments: outboundAttachments.attachments,
      assetIds: outboundAttachments.assetIds,
    };
  }

  function removeSession(session: Session) {
    sessionsByDevice.delete(session.deviceId);
    const sessions = userSessions.get(session.userId);
    if (sessions) {
      sessions.delete(session);
      if (sessions.size === 0) {
        userSessions.delete(session.userId);
      }
    }
  }

  function registerSession(session: Session) {
    const existing = sessionsByDevice.get(session.deviceId);
    if (existing && existing.socket !== session.socket) {
      sendJson(existing.socket, {
        type: "error",
        code: "session_replaced",
        message: "Session replaced",
      })
        .catch(() => {})
        .finally(() => existing.socket.close(SESSION_REPLACED_CODE));
      removeSession(existing);
    }
    sessionsByDevice.set(session.deviceId, session);
    const set = userSessions.get(session.userId) ?? new Set();
    set.add(session);
    userSessions.set(session.userId, set);
    void syncSessionStore(session);
  }

  async function syncSessionStore(session: Session) {
    await recordClawlineSessionActivity({
      storePath: sessionStorePath,
      sessionKey: session.sessionKey,
      sessionId: session.sessionId,
      sessionFile: resolveSessionTranscriptPath(session.sessionId, mainSessionAgentId),
      displayName: session.claimedName ?? session.deviceInfo?.model ?? null,
      logger,
    });
  }

  // Clawline WS payloads are runtime-validated; keep `any` here to avoid a huge type layer.
  // oxlint-disable-next-line typescript/no-explicit-any
  async function processClientMessage(session: Session, payload: any) {
    try {
      if (payload.type !== "message") {
        throw new ClientMessageError("invalid_message", "Unsupported type");
      }
      if (typeof payload.id !== "string" || !payload.id.startsWith("c_")) {
        throw new ClientMessageError("invalid_message", "Invalid id");
      }
      const rawContent = typeof payload.content === "string" ? payload.content : "";
      const attachmentsInfo = normalizeAttachmentsInput(payload.attachments, config.media);
      const hasContent = rawContent.trim().length > 0;
      if (!hasContent && attachmentsInfo.attachments.length === 0) {
        throw new ClientMessageError("invalid_message", "Missing content");
      }
      const contentBytes = Buffer.byteLength(rawContent, "utf8");
      if (contentBytes > config.sessions.maxMessageBytes) {
        throw new ClientMessageError("payload_too_large", "Message too large");
      }
      const attachmentsHash = hashAttachments(attachmentsInfo.attachments);
      const payloadSessionKey =
        typeof payload.sessionKey === "string" ? payload.sessionKey.trim() : "";
      const normalizedPayloadSessionKey = payloadSessionKey
        ? normalizeStreamMutationSessionKeyForUser(session.userId, payloadSessionKey)
        : "";
      if (payloadSessionKey && !normalizedPayloadSessionKey) {
        throw new ClientMessageError("stream_not_found", "Stream not found");
      }
      const allowedSessionKeys = session.provisionedSessionKeys?.length
        ? session.provisionedSessionKeys
        : [session.sessionKey];
      // Legacy clients may omit sessionKey; default to the Main stream session key.
      const resolvedSessionKey = normalizedPayloadSessionKey || session.sessionKey;
      if (
        !allowedSessionKeys.some(
          (sessionKey) =>
            normalizeSessionKey(sessionKey) === normalizeSessionKey(resolvedSessionKey),
        )
      ) {
        throw new ClientMessageError("stream_not_found", "Stream not found");
      }
      let streamSuffix = "main";
      if (sessionKeyEq(resolvedSessionKey, session.personalSessionKey)) {
        streamSuffix = "main";
      } else if (
        session.dmScope !== "main" &&
        sessionKeyEq(resolvedSessionKey, session.dmSessionKey)
      ) {
        streamSuffix = "dm";
      } else if (sessionKeyEq(resolvedSessionKey, session.globalSessionKey)) {
        streamSuffix = "global";
      } else {
        const parsed = parseClawlineUserSessionKey(resolvedSessionKey);
        const normalizedUserId = sanitizeUserId(session.userId).toLowerCase();
        if (!parsed || parsed.userId !== normalizedUserId) {
          throw new ClientMessageError("stream_not_found", "Stream not found");
        }
        streamSuffix = parsed.streamSuffix;
      }
      logger.info?.("[clawline] inbound message routing", {
        messageId: payload.id,
        payloadSessionKey: payload.sessionKey,
        resolvedSessionKey,
        streamSuffix,
        sessionIsAdmin: session.isAdmin,
        userId: session.userId,
        deviceId: session.deviceId,
        sessionKey: session.sessionKey,
      });
      if (streamSuffix === "global" && !session.isAdmin) {
        throw new ClientMessageError("forbidden", "Admin channel requires admin access");
      }
      const targetUserId = session.userId;

      await runPerUserTask(
        session.userId,
        async () => {
          const existing = selectMessageStmt.get(session.deviceId, payload.id) as
            | {
                deviceId: string;
                contentHash: string;
                attachmentsHash: string;
                streaming: number;
                ackSent: number;
              }
            | undefined;
          const incomingHash = sha256(rawContent);
          if (existing) {
            if (
              existing.contentHash !== incomingHash ||
              existing.attachmentsHash !== attachmentsHash
            ) {
              throw new ClientMessageError("invalid_message", "Duplicate mismatch");
            }
            if (existing.streaming === (MessageStreamingState.Failed as number)) {
              throw new ClientMessageError("invalid_message", "Message failed");
            }
            if (existing.ackSent === 0) {
              session.socket.send(JSON.stringify({ type: "ack", id: payload.id }), (err) => {
                if (!err) {
                  markAckSent(session.deviceId, payload.id);
                }
              });
            } else {
              session.socket.send(JSON.stringify({ type: "ack", id: payload.id }), () => {});
            }
            return;
          }

          if (!messageRateLimiter.attempt(session.deviceId)) {
            throw new ClientMessageError("rate_limited", "Too many messages");
          }

          const materialized = await materializeInlineAttachments({
            attachments: attachmentsInfo.attachments,
            ownerUserId: targetUserId,
            deviceId: session.deviceId,
          });
          const assetIds = attachmentsInfo.assetIds.concat(materialized.inlineAssetIds);
          const ownership = await ensureChannelAttachmentOwnership({
            attachments: materialized.attachments,
            assetIds,
            session,
          });

          const { event } = await persistUserMessage(
            session,
            targetUserId,
            payload.id,
            rawContent,
            ownership.attachments,
            attachmentsHash,
            ownership.assetIds,
            resolvedSessionKey,
          );
          await new Promise<void>((resolve) => {
            session.socket.send(JSON.stringify({ type: "ack", id: payload.id }), (err) => {
              if (!err) {
                markAckSent(session.deviceId, payload.id);
              }
              resolve();
            });
          });
          broadcastToSessionKey(resolvedSessionKey, event);

          const attachmentSummary = describeClawlineAttachments(ownership.attachments);
          const inboundBody = attachmentSummary
            ? `${rawContent}\n\n${attachmentSummary}`
            : rawContent;
          const inboundImages = clawlineAttachmentsToImages(ownership.attachments);

          const channelLabel = "clawline";
          const routeSessionKey = resolvedSessionKey;
          const route = {
            agentId: mainSessionAgentId,
            channel: "clawline",
            accountId: DEFAULT_ACCOUNT_ID,
            sessionKey: routeSessionKey,
            mainSessionKey,
          };
          const peerId = session.peerId;

          const deliveryTarget = ClawlineDeliveryTarget.fromParts(session.userId, streamSuffix);
          const systemPromptParts = [adapterOverrides.systemPrompt?.trim() || null].filter(
            (entry): entry is string => Boolean(entry),
          );
          const groupSystemPrompt =
            systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
          const ctxPayload = finalizeInboundContext({
            Body: inboundBody,
            RawBody: rawContent,
            CommandBody: rawContent,
            From: `${channelLabel}:${peerId}`,
            To: `device:${session.deviceId}`,
            SessionKey: route.sessionKey,
            AccountId: route.accountId,
            MessageSid: payload.id,
            ChatType: "direct",
            SenderName: session.claimedName ?? session.deviceInfo?.model ?? peerId,
            SenderId: session.userId,
            Provider: "clawline",
            Surface: channelLabel,
            OriginatingChannel: channelLabel,
            OriginatingTo: deliveryTarget.toString(),
            GroupSystemPrompt: groupSystemPrompt,
            CommandAuthorized: true,
          });
          const updateLastRoute =
            streamSuffix === "dm" && session.dmScope !== "main"
              ? {
                  // DM cross-session "follow me" write: tell agent:main:main where this user is currently talking.
                  sessionKey: route.mainSessionKey,
                  channel: "clawline",
                  to: deliveryTarget.toString(),
                  accountId: route.accountId,
                }
              : undefined;
          await recordInboundSession({
            storePath: sessionStorePath,
            sessionKey: route.sessionKey,
            ctx: ctxPayload,
            updateLastRoute,
            onRecordError: (err) => {
              logger.warn?.(`[clawline] failed recording inbound session: ${formatError(err)}`);
            },
          });

          const fallbackText = adapterOverrides.responseFallback?.trim() ?? "";
          const prefixContext: ResponsePrefixContext = {
            identityName: resolveIdentityName(openClawCfg, route.agentId),
          };

          // Track activity state for typing indicator
          let activitySignaled = false;
          const sendActivitySignal = async (isActive: boolean) => {
            logger.info?.("[clawline] activity_signal", {
              isActive,
              messageId: payload.id,
              sessionKey: route.sessionKey,
            });
            await sendJson(session.socket, {
              type: "event",
              event: "activity",
              payload: {
                isActive,
                messageId: payload.id,
                sessionKey: route.sessionKey,
              },
            }).catch(() => {});
          };

          const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
            responsePrefix: resolveEffectiveMessagesConfig(openClawCfg, route.agentId)
              .responsePrefix,
            responsePrefixContextProvider: () => prefixContext,
            humanDelay: resolveHumanDelayConfig(openClawCfg, route.agentId),
            deliver: async (replyPayload) => {
              // Stop activity signal when first content arrives (streaming begins)
              if (activitySignaled) {
                activitySignaled = false;
                void sendActivitySignal(false);
              }
              const mediaUrls = replyPayload.mediaUrls?.length
                ? replyPayload.mediaUrls
                : replyPayload.mediaUrl
                  ? [replyPayload.mediaUrl]
                  : [];
              let attachments: NormalizedAttachment[] = [];
              const trimmedText = replyPayload.text?.trim();
              if (mediaUrls.length > 0) {
                try {
                  const materialized = await materializeOutboundMediaUrls({
                    mediaUrls,
                    ownerUserId: targetUserId,
                    uploaderDeviceId: session.deviceId,
                  });
                  attachments = materialized.attachments;
                } catch (err) {
                  logger.warn?.(`[clawline] reply_media_attachment_failed: ${formatError(err)}`);
                }
              }
              const assistantText =
                trimmedText && trimmedText.length > 0
                  ? trimmedText
                  : attachments.length > 0
                    ? ""
                    : buildAssistantTextFromPayload(replyPayload, fallbackText);
              if (assistantText === null) {
                return;
              }
              const assistantEvent = await persistAssistantMessage(
                session,
                targetUserId,
                assistantText,
                route.sessionKey,
                attachments,
              );
              broadcastToSessionKey(resolvedSessionKey, assistantEvent);
            },
            onError: (err, info) => {
              logger.error?.("[clawline] reply_delivery_failed", {
                kind: info.kind,
                error: err instanceof Error ? err.message : String(err),
              });
            },
            onReplyStart: async () => {
              // Signal that processing has started (for typing indicator)
              if (!activitySignaled) {
                activitySignaled = true;
                await sendActivitySignal(true);
              }
            },
          });

          logger.info?.("[clawline] agent_run_start", {
            messageId: payload.id,
            sessionId: session.sessionId,
            sessionKey: resolvedSessionKey,
            userId: session.userId,
            deviceId: session.deviceId,
          });

          let queuedFinal = false;
          let deliveredCount = 0;
          try {
            const result = await dispatchReplyFromConfig({
              ctx: ctxPayload,
              cfg: openClawCfg,
              dispatcher,
              replyOptions: {
                ...replyOptions,
                images: inboundImages.length > 0 ? inboundImages : undefined,
                onModelSelected: (ctx) => {
                  prefixContext.provider = ctx.provider;
                  prefixContext.model = extractShortModelName(ctx.model);
                  prefixContext.modelFull = `${ctx.provider}/${ctx.model}`;
                  prefixContext.thinkingLevel = ctx.thinkLevel ?? "off";
                },
              },
              replyResolver: options.replyResolver,
            });
            queuedFinal = result.queuedFinal;
            // Count all delivered content (streaming blocks, tool results, and final replies)
            deliveredCount = result.counts.block + result.counts.tool + result.counts.final;
          } catch (err) {
            logger.error?.(`[clawline] dispatch_failed: ${formatError(err)}`);
            queuedFinal = false;
          }
          markDispatchIdle();
          await dispatcher.waitForIdle();

          // Always send activity=false when done
          if (activitySignaled) {
            activitySignaled = false;
            void sendActivitySignal(false);
          }

          // Check if message was successfully handled:
          // 1. queuedFinal = true means a final reply was sent
          // 2. deliveredCount > 0 means content was streamed (blocks/tools)
          // 3. queueDepth > 0 means message was queued for later processing
          const queueKey = route.sessionKey;
          const queueDepth = getFollowupQueueDepth(queueKey);
          const wasDelivered = queuedFinal || deliveredCount > 0;
          const wasQueued = !wasDelivered && queueDepth > 0;

          logger.info?.("[clawline] agent_run_end", {
            messageId: payload.id,
            sessionId: session.sessionId,
            sessionKey: resolvedSessionKey,
            userId: session.userId,
            deviceId: session.deviceId,
            deliveredCount,
            queuedFinal,
            queueDepth,
            wasDelivered,
            wasQueued,
          });

          if (!wasDelivered && !wasQueued) {
            updateMessageStreamingStmt.run(
              MessageStreamingState.Failed,
              session.deviceId,
              payload.id,
            );
            await sendJson(session.socket, {
              type: "error",
              code: "server_error",
              message: "Unable to deliver reply",
              messageId: payload.id,
            }).catch(() => {});
            return;
          }

          // Message was either delivered or queued successfully
          updateMessageStreamingStmt.run(
            wasQueued ? MessageStreamingState.Queued : MessageStreamingState.Finalized,
            session.deviceId,
            payload.id,
          );
        },
        { streamKey: resolvedSessionKey },
      );
    } catch (err) {
      if (err instanceof ClientMessageError) {
        await sendJson(session.socket, {
          type: "error",
          code: err.code,
          message: err.message,
        }).catch(() => {});
        return;
      }
      if (err instanceof HttpError) {
        await sendJson(session.socket, {
          type: "error",
          code: err.code,
          message: err.message,
        }).catch(() => {});
        return;
      }
      // Log unexpected errors and notify client so UI can show failure
      logger.error?.("[clawline] processClientMessage_unexpected_error", {
        error: err instanceof Error ? err.message : String(err),
        messageId: payload?.id,
        userId: session.userId,
      });
      await sendJson(session.socket, {
        type: "error",
        code: "server_error",
        message: "Message processing failed",
        messageId: payload?.id,
      }).catch(() => {});
    }
  }

  // oxlint-disable-next-line typescript/no-explicit-any
  async function processInteractiveCallback(session: Session, payload: any) {
    try {
      const sourceMessageId = typeof payload.messageId === "string" ? payload.messageId.trim() : "";
      if (!sourceMessageId) {
        throw new ClientMessageError("invalid_message", "Missing messageId");
      }

      const callbackPayload =
        payload.payload && typeof payload.payload === "object"
          ? (payload.payload as Record<string, unknown>)
          : null;
      const action =
        callbackPayload && typeof callbackPayload.action === "string"
          ? callbackPayload.action.trim()
          : "";
      if (!action) {
        throw new ClientMessageError("invalid_message", "Missing action");
      }
      if (action.length > MAX_INTERACTIVE_ACTION_CHARS) {
        throw new ClientMessageError("invalid_message", "action too long");
      }

      const dataValue = callbackPayload ? callbackPayload.data : null;
      const { json: dataJson, bytes: dataBytes } = safeJsonStringify(dataValue);
      if (dataBytes > MAX_INTERACTIVE_DATA_BYTES) {
        throw new ClientMessageError("payload_too_large", "data payload too large");
      }

      // Best-effort: route the callback to the same sessionKey the source message was delivered on.
      // Guard with userId to prevent cross-user routing.
      let resolvedSessionKey = session.sessionKey;
      const sourceRow = selectEventPayloadForUserStmt.get(session.userId, sourceMessageId) as
        | { payloadJson: string }
        | undefined;
      if (sourceRow && typeof sourceRow.payloadJson === "string") {
        const parsed = parseServerMessage(sourceRow.payloadJson, logger);
        const hinted = typeof parsed?.sessionKey === "string" ? parsed.sessionKey.trim() : "";
        if (hinted) {
          resolvedSessionKey = hinted;
        }
      }

      const allowedSessionKeys = session.provisionedSessionKeys?.length
        ? session.provisionedSessionKeys
        : [session.sessionKey];
      if (
        !allowedSessionKeys.some(
          (sessionKey) => sessionKey.toLowerCase() === resolvedSessionKey.toLowerCase(),
        )
      ) {
        resolvedSessionKey = session.sessionKey;
      }

      let streamSuffix: "main" | "dm" | "global" = "main";
      if (sessionKeyEq(resolvedSessionKey, session.personalSessionKey)) {
        streamSuffix = "main";
      } else if (
        session.dmScope !== "main" &&
        sessionKeyEq(resolvedSessionKey, session.dmSessionKey)
      ) {
        streamSuffix = "dm";
      } else if (sessionKeyEq(resolvedSessionKey, session.globalSessionKey)) {
        streamSuffix = "global";
      }
      if (streamSuffix === "global" && !session.isAdmin) {
        throw new ClientMessageError("forbidden", "Admin channel requires admin access");
      }

      const callbackEnvelope = {
        messageId: sourceMessageId,
        payload: { action, data: dataValue === undefined ? null : dataValue },
      };
      const { json: callbackJson } = safeJsonStringify(callbackEnvelope);
      const docAttachment: NormalizedAttachment = {
        type: "document",
        mimeType: INTERACTIVE_CALLBACK_MIME,
        data: Buffer.from(callbackJson, "utf8").toString("base64"),
      };

      const prefix = `[Interactive] action=${action} -- `;
      const maxBytes = config.sessions.maxMessageBytes;
      const prefixBytes = Buffer.byteLength(prefix, "utf8");
      // Ensure the text fallback stays within maxMessageBytes even when data is near the 64KB cap.
      const dataBudget = Math.max(0, maxBytes - prefixBytes);
      const dataForText =
        Buffer.byteLength(dataJson, "utf8") <= dataBudget
          ? dataJson
          : `${truncateUtf8(dataJson, Math.max(0, dataBudget - 3))}...`;
      const rawContent = `${prefix}${dataForText}`;

      const targetUserId = session.userId;
      const attachments: NormalizedAttachment[] = [docAttachment];
      const attachmentsHash = hashAttachments(attachments);
      const assetIds: string[] = [];

      await runPerUserTask(
        session.userId,
        async () => {
          if (!messageRateLimiter.attempt(session.deviceId)) {
            throw new ClientMessageError("rate_limited", "Too many messages");
          }

          const clientId = `c_${randomUUID()}`;

          const { event } = await persistUserMessage(
            session,
            targetUserId,
            clientId,
            rawContent,
            attachments,
            attachmentsHash,
            assetIds,
            resolvedSessionKey,
          );
          broadcastToSessionKey(resolvedSessionKey, event);

          const attachmentSummary = describeClawlineAttachments(attachments);
          const inboundBody = attachmentSummary
            ? `${rawContent}\n\n${attachmentSummary}`
            : rawContent;
          const inboundImages = clawlineAttachmentsToImages(attachments);

          const channelLabel = "clawline";
          const routeSessionKey = resolvedSessionKey;
          const route = {
            agentId: mainSessionAgentId,
            channel: "clawline",
            accountId: DEFAULT_ACCOUNT_ID,
            sessionKey: routeSessionKey,
            mainSessionKey,
          };
          const peerId = session.peerId;

          const deliveryTarget = ClawlineDeliveryTarget.fromParts(session.userId, streamSuffix);
          const systemPromptParts = [adapterOverrides.systemPrompt?.trim() || null].filter(
            (entry): entry is string => Boolean(entry),
          );
          const groupSystemPrompt =
            systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
          const ctxPayload = finalizeInboundContext({
            Body: inboundBody,
            RawBody: rawContent,
            CommandBody: rawContent,
            From: `${channelLabel}:${peerId}`,
            To: `device:${session.deviceId}`,
            SessionKey: route.sessionKey,
            AccountId: route.accountId,
            MessageSid: clientId,
            ChatType: "direct",
            SenderName: session.claimedName ?? session.deviceInfo?.model ?? peerId,
            SenderId: session.userId,
            Provider: "clawline",
            Surface: channelLabel,
            OriginatingChannel: channelLabel,
            OriginatingTo: deliveryTarget.toString(),
            GroupSystemPrompt: groupSystemPrompt,
            CommandAuthorized: true,
          });
          const updateLastRoute =
            streamSuffix === "dm" && session.dmScope !== "main"
              ? {
                  // DM cross-session "follow me" write: tell agent:main:main where this user is currently talking.
                  sessionKey: route.mainSessionKey,
                  channel: "clawline",
                  to: deliveryTarget.toString(),
                  accountId: route.accountId,
                }
              : undefined;
          await recordInboundSession({
            storePath: sessionStorePath,
            sessionKey: route.sessionKey,
            ctx: ctxPayload,
            updateLastRoute,
            onRecordError: (err) => {
              logger.warn?.(`[clawline] failed recording inbound session: ${formatError(err)}`);
            },
          });

          const fallbackText = adapterOverrides.responseFallback?.trim() ?? "";
          const prefixContext: ResponsePrefixContext = {
            identityName: resolveIdentityName(openClawCfg, route.agentId),
          };

          // Track activity state for typing indicator
          let activitySignaled = false;
          const sendActivitySignal = async (isActive: boolean) => {
            logger.info?.("[clawline] activity_signal", {
              isActive,
              messageId: clientId,
              sessionKey: route.sessionKey,
            });
            await sendJson(session.socket, {
              type: "event",
              event: "activity",
              payload: {
                isActive,
                messageId: clientId,
                sessionKey: route.sessionKey,
              },
            }).catch(() => {});
          };

          const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
            responsePrefix: resolveEffectiveMessagesConfig(openClawCfg, route.agentId)
              .responsePrefix,
            responsePrefixContextProvider: () => prefixContext,
            humanDelay: resolveHumanDelayConfig(openClawCfg, route.agentId),
            deliver: async (replyPayload) => {
              // Stop activity signal when first content arrives (streaming begins)
              if (activitySignaled) {
                activitySignaled = false;
                void sendActivitySignal(false);
              }
              const mediaUrls = replyPayload.mediaUrls?.length
                ? replyPayload.mediaUrls
                : replyPayload.mediaUrl
                  ? [replyPayload.mediaUrl]
                  : [];
              let replyAttachments: NormalizedAttachment[] = [];
              const trimmedText = replyPayload.text?.trim();
              if (mediaUrls.length > 0) {
                try {
                  const materialized = await materializeOutboundMediaUrls({
                    mediaUrls,
                    ownerUserId: targetUserId,
                    uploaderDeviceId: session.deviceId,
                  });
                  replyAttachments = materialized.attachments;
                } catch (err) {
                  logger.warn?.(`[clawline] reply_media_attachment_failed: ${formatError(err)}`);
                }
              }
              const assistantText =
                trimmedText && trimmedText.length > 0
                  ? trimmedText
                  : replyAttachments.length > 0
                    ? ""
                    : buildAssistantTextFromPayload(replyPayload, fallbackText);
              if (assistantText === null) {
                return;
              }
              const assistantEvent = await persistAssistantMessage(
                session,
                targetUserId,
                assistantText,
                route.sessionKey,
                replyAttachments,
              );
              broadcastToSessionKey(resolvedSessionKey, assistantEvent);
            },
            onError: (err, info) => {
              logger.error?.("[clawline] reply_delivery_failed", {
                kind: info.kind,
                error: err instanceof Error ? err.message : String(err),
              });
            },
            onReplyStart: async () => {
              // Signal that processing has started (for typing indicator)
              if (!activitySignaled) {
                activitySignaled = true;
                await sendActivitySignal(true);
              }
            },
          });

          logger.info?.("[clawline] agent_run_start", {
            messageId: clientId,
            sessionId: session.sessionId,
            sessionKey: resolvedSessionKey,
            userId: session.userId,
            deviceId: session.deviceId,
            sourceMessageId,
            interactiveAction: action,
          });

          let queuedFinal = false;
          let deliveredCount = 0;
          try {
            const result = await dispatchReplyFromConfig({
              ctx: ctxPayload,
              cfg: openClawCfg,
              dispatcher,
              replyOptions: {
                ...replyOptions,
                images: inboundImages.length > 0 ? inboundImages : undefined,
                onModelSelected: (ctx) => {
                  prefixContext.provider = ctx.provider;
                  prefixContext.model = extractShortModelName(ctx.model);
                  prefixContext.modelFull = `${ctx.provider}/${ctx.model}`;
                  prefixContext.thinkingLevel = ctx.thinkLevel ?? "off";
                },
              },
              replyResolver: options.replyResolver,
            });
            queuedFinal = result.queuedFinal;
            // Count all delivered content (streaming blocks, tool results, and final replies)
            deliveredCount = result.counts.block + result.counts.tool + result.counts.final;
          } catch (err) {
            logger.error?.(`[clawline] dispatch_failed: ${formatError(err)}`);
            queuedFinal = false;
          }
          markDispatchIdle();
          await dispatcher.waitForIdle();

          // Always send activity=false when done
          if (activitySignaled) {
            activitySignaled = false;
            void sendActivitySignal(false);
          }

          const queueKey = route.sessionKey;
          const queueDepth = getFollowupQueueDepth(queueKey);
          const wasDelivered = queuedFinal || deliveredCount > 0;
          const wasQueued = !wasDelivered && queueDepth > 0;

          logger.info?.("[clawline] agent_run_end", {
            messageId: clientId,
            sessionId: session.sessionId,
            sessionKey: resolvedSessionKey,
            userId: session.userId,
            deviceId: session.deviceId,
            deliveredCount,
            queuedFinal,
            queueDepth,
            wasDelivered,
            wasQueued,
            sourceMessageId,
            interactiveAction: action,
          });

          if (!wasDelivered && !wasQueued) {
            updateMessageStreamingStmt.run(
              MessageStreamingState.Failed,
              session.deviceId,
              clientId,
            );
            await sendJson(session.socket, {
              type: "error",
              code: "server_error",
              message: "Unable to deliver reply",
              messageId: clientId,
            }).catch(() => {});
            return;
          }

          updateMessageStreamingStmt.run(
            wasQueued ? MessageStreamingState.Queued : MessageStreamingState.Finalized,
            session.deviceId,
            clientId,
          );
        },
        { streamKey: resolvedSessionKey },
      );
    } catch (err) {
      if (err instanceof ClientMessageError) {
        await sendJson(session.socket, {
          type: "error",
          code: err.code,
          message: err.message,
        }).catch(() => {});
        return;
      }
      if (err instanceof HttpError) {
        await sendJson(session.socket, {
          type: "error",
          code: err.code,
          message: err.message,
        }).catch(() => {});
        return;
      }
      logger.error?.("[clawline] processInteractiveCallback_unexpected_error", {
        error: err instanceof Error ? err.message : String(err),
        messageId: payload?.messageId,
        userId: session.userId,
        deviceId: session.deviceId,
      });
      await sendJson(session.socket, {
        type: "error",
        code: "server_error",
        message: "Message processing failed",
        messageId: payload?.messageId,
      }).catch(() => {});
    }
  }

  function expirePendingPairs() {
    if (config.pairing.pendingTtlSeconds <= 0 && config.pairing.pendingSocketTimeoutSeconds <= 0) {
      return;
    }
    const now = nowMs();
    const socketTtlMs =
      Math.max(1, config.pairing.pendingSocketTimeoutSeconds ?? config.pairing.pendingTtlSeconds) *
      1000;
    for (const [deviceId, pending] of pendingSockets) {
      if (now - pending.createdAt >= socketTtlMs) {
        pendingSockets.delete(deviceId);
        void removePendingEntry(deviceId).catch(() => {});
        void sendJson(pending.socket, {
          type: "pair_result",
          success: false,
          reason: "pair_timeout",
        })
          .catch(() => {})
          .finally(() => {
            pending.socket.close(1000);
          });
      }
    }
  }

  function handleSocketClose(socket: WebSocket) {
    const state = connectionState.get(socket);
    if (state && state.deviceId && state.userId && state.sessionId) {
      const session = sessionsByDevice.get(state.deviceId);
      if (session && session.socket === socket) {
        removeSession(session);
      }
    }
    for (const [deviceId, pending] of pendingSockets) {
      if (pending.socket === socket) {
        pendingSockets.delete(deviceId);
        logger.info?.("[clawline:http] pending_socket_closed", { deviceId });
        break;
      }
    }
    connectionState.delete(socket);
  }

  function validateDeviceId(value: unknown): value is string {
    return typeof value === "string" && UUID_V4_REGEX.test(value);
  }

  type ResolvedSendTarget =
    | { kind: "user"; userId: string }
    | { kind: "device"; userId: string; deviceId: string };

  function resolveSessionTargetFromSessionKey(sessionKey: string): ResolvedSendTarget {
    const trimmed = sessionKey.trim();
    if (!trimmed) {
      throw new Error("Delivering to clawline requires --to <userId|deviceId>");
    }
    const lower = trimmed.toLowerCase();
    if (lower === mainSessionKey.toLowerCase()) {
      const adminEntry = allowlist.entries.find((entry) => entry.isAdmin);
      if (!adminEntry) {
        throw new Error("No admin allowlist entry found for main session routing");
      }
      return resolveUserTarget(adminEntry.userId);
    }
    // Parse for storage only (userId); routing continues to rely on the session key itself.
    const userId = extractUserIdFromSessionKey(trimmed);
    if (!userId) {
      throw new Error("Invalid clawline session key");
    }
    return resolveUserTarget(userId);
  }

  function extractUserIdFromSessionKey(sessionKey: string): string | null {
    const parts = sessionKey.split(":");
    if (parts.length < 5) {
      return null;
    }
    if (parts[0]?.toLowerCase() !== "agent" || parts[2]?.toLowerCase() !== "clawline") {
      return null;
    }
    const userId = parts[3]?.trim();
    return userId ? userId : null;
  }

  function resolveSendTarget(raw: string): ResolvedSendTarget {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error("Delivering to clawline requires --to <userId|deviceId>");
    }
    const lower = trimmed.toLowerCase();
    if (lower.startsWith("user:")) {
      const userId = trimmed.slice("user:".length).trim();
      if (!userId) {
        throw new Error("Delivering to clawline requires user:ID or device:ID target");
      }
      return resolveUserTarget(userId);
    }
    if (lower.startsWith("device:")) {
      const deviceId = trimmed.slice("device:".length).trim();
      if (!deviceId) {
        throw new Error("Delivering to clawline requires user:ID or device:ID target");
      }
      return resolveDeviceTarget(deviceId);
    }
    if (validateDeviceId(trimmed)) {
      return resolveDeviceTarget(trimmed);
    }
    return resolveUserTarget(trimmed);
  }

  function resolveDeviceTarget(deviceId: string): ResolvedSendTarget {
    const entry = findAllowlistEntry(deviceId);
    if (!entry) {
      throw new Error(`Unknown clawline device: ${deviceId}`);
    }
    return { kind: "device", deviceId: entry.deviceId, userId: entry.userId };
  }

  function resolveUserTarget(userId: string): ResolvedSendTarget {
    const normalizedId = userId.toLowerCase();
    const entries = allowlist.entries.filter(
      (entry) => entry.userId.toLowerCase() === normalizedId,
    );
    if (entries.length === 0) {
      throw new Error(`Unknown clawline user: ${userId}`);
    }
    // Return the canonical userId from the allowlist (preserves original casing)
    return { kind: "user", userId: entries[0].userId };
  }

  wss.on("connection", (ws, req) => {
    logger.info?.("[clawline:http] ws_connection_open", {
      origin: req?.headers?.origin ?? "null",
      remoteAddress: req?.socket?.remoteAddress,
    });
    connectionState.set(ws, { authenticated: false });

    ws.on("message", async (raw) => {
      const rawString = rawDataToString(raw);
      logger.info?.("[clawline:http] ws_message_received", {
        bytes: Buffer.byteLength(rawString, "utf8"),
      });
      // oxlint-disable-next-line typescript/no-explicit-any
      let payload: any;
      try {
        payload = JSON.parse(rawString);
      } catch {
        await sendJson(ws, { type: "error", code: "invalid_message", message: "Malformed JSON" });
        ws.close();
        return;
      }
      if (!payload || typeof payload.type !== "string") {
        await sendJson(ws, { type: "error", code: "invalid_message", message: "Missing type" });
        return;
      }
      switch (payload.type) {
        case "pair_request":
          logger.info?.("[clawline:http] ws_pair_request_dispatch", {
            deviceId: payload.deviceId,
            protocolVersion: payload.protocolVersion,
          });
          await handlePairRequest(ws, payload);
          break;
        case "auth":
          await handleAuth(ws, payload);
          break;
        case "message":
          await handleAuthedMessage(ws, payload);
          break;
        case "interactive-callback":
          await handleAuthedInteractiveCallback(ws, payload);
          break;
        default:
          await sendJson(ws, { type: "error", code: "invalid_message", message: "Unknown type" });
      }
    });

    ws.on("close", () => handleSocketClose(ws));
    ws.on("error", () => handleSocketClose(ws));
  });

  terminalWss.on("connection", (ws, req) => {
    logger.info?.("[clawline:http] terminal_ws_connection_open", {
      origin: req?.headers?.origin ?? "null",
      remoteAddress: req?.socket?.remoteAddress,
    });
    terminalConnectionState.set(ws, { authenticated: false });

    ws.on("message", (raw, isBinary) => {
      void handleTerminalMessage(ws, raw, isBinary);
    });

    ws.on("close", () => teardownTerminalSocket(ws));
    ws.on("error", () => teardownTerminalSocket(ws));
  });

  function teardownTerminalSocket(ws: WebSocket) {
    const state = terminalConnectionState.get(ws);
    if (state && state.authenticated) {
      try {
        state.pty?.kill?.();
      } catch {
        // ignore
      }
    }
    terminalConnectionState.delete(ws);
  }

  async function handleTerminalMessage(ws: WebSocket, raw: WebSocket.RawData, isBinary: boolean) {
    const state = terminalConnectionState.get(ws);
    if (!state) {
      return;
    }
    if (!state.authenticated) {
      if (isBinary) {
        void sendJson(ws, { type: "terminal_error", message: "Expected terminal_auth" });
        ws.close();
        return;
      }
      const rawString = rawDataToString(raw);
      // oxlint-disable-next-line typescript/no-explicit-any
      let payload: any;
      try {
        payload = JSON.parse(rawString);
      } catch {
        void sendJson(ws, { type: "terminal_error", message: "Malformed JSON" });
        ws.close();
        return;
      }
      if (!payload || payload.type !== "terminal_auth") {
        void sendJson(ws, { type: "terminal_error", message: "Expected terminal_auth" });
        ws.close();
        return;
      }
      await handleTerminalAuth(ws, payload);
      return;
    }

    if (isBinary) {
      const buf = Buffer.isBuffer(raw)
        ? raw
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw)
          : Array.isArray(raw)
            ? Buffer.concat(raw)
            : Buffer.from(String(raw));
      state.pty.write(buf.toString("utf8"));
      return;
    }

    const rawString = rawDataToString(raw);
    // oxlint-disable-next-line typescript/no-explicit-any
    let payload: any;
    try {
      payload = JSON.parse(rawString);
    } catch {
      return;
    }
    if (!payload || typeof payload.type !== "string") {
      return;
    }
    switch (payload.type) {
      case "terminal_resize": {
        const cols = typeof payload.cols === "number" ? Math.floor(payload.cols) : 0;
        const rows = typeof payload.rows === "number" ? Math.floor(payload.rows) : 0;
        if (cols > 0 && rows > 0) {
          try {
            state.pty.resize(cols, rows);
          } catch {
            // ignore
          }
          void resizeTmuxPane(state.paneId, cols, rows);
        }
        break;
      }
      case "terminal_detach": {
        try {
          state.pty.kill();
        } catch {
          // ignore
        }
        void sendJson(ws, { type: "terminal_closed" });
        ws.close();
        break;
      }
      case "terminal_close": {
        void killTmuxSession(state.tmuxSessionName);
        try {
          state.pty.kill();
        } catch {
          // ignore
        }
        void sendJson(ws, { type: "terminal_closed" });
        ws.close();
        break;
      }
      default:
        break;
    }
  }

  // oxlint-disable-next-line typescript/no-explicit-any
  async function handleTerminalAuth(ws: WebSocket, payload: any) {
    if (payload.protocolVersion !== PROTOCOL_VERSION) {
      await sendJson(ws, { type: "terminal_error", message: "Unsupported protocol" });
      ws.close();
      return;
    }
    const terminalSessionId =
      typeof payload.terminalSessionId === "string" ? payload.terminalSessionId.trim() : "";
    if (!terminalSessionId) {
      await sendJson(ws, { type: "terminal_error", message: "Missing terminalSessionId" });
      ws.close();
      return;
    }
    const deviceId = typeof payload.deviceId === "string" ? payload.deviceId : "";
    const authToken = typeof payload.authToken === "string" ? payload.authToken : "";
    if (!validateDeviceId(deviceId) || !authToken) {
      await sendJson(ws, { type: "terminal_error", message: "Invalid auth" });
      ws.close();
      return;
    }
    if (!authRateLimiter.attempt(deviceId)) {
      await sendJson(ws, { type: "terminal_error", message: "Rate limited" });
      ws.close(1008);
      return;
    }
    let decoded: jwt.JwtPayload;
    try {
      decoded = jwt.verify(authToken, jwtKey, { algorithms: ["HS256"] }) as jwt.JwtPayload;
    } catch {
      await sendJson(ws, { type: "terminal_error", message: "Auth failed" });
      ws.close();
      return;
    }
    if (
      typeof decoded.deviceId !== "string" ||
      !timingSafeStringEqual(decoded.deviceId, deviceId) ||
      typeof decoded.sub !== "string"
    ) {
      await sendJson(ws, { type: "terminal_error", message: "Auth failed" });
      ws.close();
      return;
    }
    const entry = findAllowlistEntry(deviceId);
    if (
      !entry ||
      !timingSafeStringEqual(decoded.sub, entry.userId) ||
      isDenylisted(entry.deviceId)
    ) {
      await sendJson(ws, { type: "terminal_error", message: "Auth failed" });
      ws.close();
      return;
    }

    let record = terminalSessions.get(terminalSessionId);
    if (!record) {
      // Terminal sessions should survive provider restarts and be reconnectable without
      // requiring an in-memory registration step. If we can prove the sessionId was
      // referenced by a terminal bubble message for this user, allow + cache it.
      const dbRecord = lookupTerminalSessionRecordFromDb({
        userId: entry.userId,
        terminalSessionId,
      });
      if (!dbRecord) {
        await sendJson(ws, { type: "terminal_error", message: "Unknown terminal session" });
        ws.close();
        return;
      }
      const now = nowMs();
      const hydrated: TerminalSessionRecord = {
        terminalSessionId,
        ownerUserId: entry.userId,
        sessionKey: dbRecord.sessionKey,
        title: dbRecord.title,
        createdAt: now,
        lastSeenAt: now,
        tmuxSessionName: terminalSessionId,
      };
      terminalSessions.set(terminalSessionId, hydrated);
      record = hydrated;
    }
    if (!record) {
      await sendJson(ws, { type: "terminal_error", message: "Unknown terminal session" });
      ws.close();
      return;
    }
    if (record.ownerUserId !== entry.userId) {
      await sendJson(ws, { type: "terminal_error", message: "Forbidden" });
      ws.close();
      return;
    }

    const cols = typeof payload.cols === "number" ? Math.max(1, Math.floor(payload.cols)) : 80;
    const rows = typeof payload.rows === "number" ? Math.max(1, Math.floor(payload.rows)) : 24;
    const backfillLines =
      typeof payload.backfillLines === "number"
        ? Math.max(0, Math.floor(payload.backfillLines))
        : 0;

    let paneId = await resolveTmuxPaneId(record.tmuxSessionName);
    if (!paneId) {
      // If the session was referenced by a bubble but the tmux session hasn't been created yet,
      // create it on-demand so auth succeeds.
      const ensured = await ensureTmuxSessionExists(record.tmuxSessionName);
      if (ensured) {
        paneId = await resolveTmuxPaneId(record.tmuxSessionName);
      }
    }
    if (!paneId) {
      await sendJson(ws, { type: "terminal_error", message: "Terminal session is not running" });
      ws.close();
      return;
    }

    record.lastSeenAt = nowMs();
    await sendJson(ws, {
      type: "terminal_ready",
      terminalSessionId,
      cols,
      rows,
      readOnly: false,
      maxBackfillLines: 5000,
      backfillLinesActual: Math.min(backfillLines, 5000),
    });

    if (backfillLines > 0) {
      const backfill = await captureTmuxBackfill(paneId, Math.min(backfillLines, 5000));
      if (backfill.length > 0 && ws.readyState === WebSocket.OPEN) {
        // Chunk to avoid giant frames.
        const chunkSize = 32 * 1024;
        for (let offset = 0; offset < backfill.length; offset += chunkSize) {
          ws.send(backfill.subarray(offset, offset + chunkSize));
        }
      }
      await sendJson(ws, { type: "terminal_backfill_end" });
    }

    const { pty } = await tmuxBackend.spawnAttachPty({
      sessionName: record.tmuxSessionName,
      cols,
      rows,
    });

    terminalConnectionState.set(ws, {
      authenticated: true,
      deviceId,
      userId: entry.userId,
      terminalSessionId,
      tmuxSessionName: record.tmuxSessionName,
      paneId,
      pty,
    });

    pty.onData((data: string) => {
      if (ws.readyState !== WebSocket.OPEN) {
        return;
      }
      ws.send(Buffer.from(data, "utf8"));
    });

    pty.onExit((ev: { exitCode?: number }) => {
      void sendJson(ws, {
        type: "terminal_exit",
        code: typeof ev.exitCode === "number" ? ev.exitCode : null,
      });
      try {
        ws.close();
      } catch {
        // ignore
      }
    });
  }

  async function resolveTmuxPaneId(tmuxSessionName: string): Promise<string | null> {
    try {
      const { stdout } = await tmuxBackend.execTmux(
        ["list-panes", "-t", tmuxSessionName, "-F", "#{pane_id}"],
        { timeout: 2_000, maxBuffer: 1024 * 1024 },
      );
      const paneId = String(stdout).trim().split(/\s+/)[0];
      return paneId ? paneId : null;
    } catch {
      return null;
    }
  }

  async function captureTmuxBackfill(paneId: string, backfillLines: number): Promise<Buffer> {
    if (backfillLines <= 0) {
      return Buffer.alloc(0);
    }
    try {
      const { stdout } = await tmuxBackend.execTmux(
        ["capture-pane", "-p", "-e", "-t", paneId, "-S", `-${backfillLines}`],
        { timeout: 3_000, maxBuffer: 10 * 1024 * 1024 },
      );
      return Buffer.from(String(stdout), "utf8");
    } catch {
      return Buffer.alloc(0);
    }
  }

  async function ensureTmuxSessionExists(tmuxSessionName: string): Promise<boolean> {
    const name = typeof tmuxSessionName === "string" ? tmuxSessionName.trim() : "";
    if (!name) {
      return false;
    }

    try {
      await tmuxBackend.execTmux(["has-session", "-t", name], {
        timeout: 2_000,
        maxBuffer: 1024 * 1024,
      });
      return true;
    } catch {
      // fall through
    }

    try {
      await tmuxBackend.execTmux(["new-session", "-d", "-s", name], {
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      });
      return true;
    } catch (err) {
      logger.warn?.("[clawline:terminal] tmux_new_session_failed", {
        sessionName: name,
        error: formatError(err),
      });
      return false;
    }
  }

  async function resizeTmuxPane(paneId: string, cols: number, rows: number) {
    try {
      await tmuxBackend.execTmux(
        ["resize-pane", "-t", paneId, "-x", String(cols), "-y", String(rows)],
        { timeout: 2_000, maxBuffer: 1024 * 1024 },
      );
    } catch {
      // ignore
    }
  }

  async function killTmuxSession(tmuxSessionName: string) {
    try {
      await tmuxBackend.execTmux(["kill-session", "-t", tmuxSessionName], {
        timeout: 2_000,
        maxBuffer: 1024 * 1024,
      });
    } catch {
      // ignore
    }
  }

  // oxlint-disable-next-line typescript/no-explicit-any
  async function handlePairRequest(ws: WebSocket, payload: any) {
    logger.info?.("[clawline:http] pair_request_start", {
      deviceId: payload?.deviceId,
      protocolVersion: payload?.protocolVersion,
    });
    if (payload.protocolVersion !== PROTOCOL_VERSION) {
      await sendJson(ws, {
        type: "error",
        code: "invalid_message",
        message: "Unsupported protocol",
      });
      ws.close();
      return;
    }
    if (!validateDeviceId(payload.deviceId)) {
      logger.warn?.("[clawline:http] pair_request_invalid_device_id", {
        deviceId: payload.deviceId,
      });
      await sendJson(ws, { type: "error", code: "invalid_message", message: "Invalid deviceId" });
      return;
    }
    if (!pairRateLimiter.attempt(payload.deviceId)) {
      logger.warn?.("[clawline:http] pair_request_rate_limited", { deviceId: payload.deviceId });
      await sendJson(ws, { type: "error", code: "rate_limited", message: "Pairing rate limited" });
      ws.close(1008);
      return;
    }
    if (isDenylisted(payload.deviceId)) {
      logger.warn?.("[clawline:http] pair_request_denylisted", { deviceId: payload.deviceId });
      await sendJson(ws, { type: "pair_result", success: false, reason: "pair_rejected" });
      ws.close();
      return;
    }
    if (!validateDeviceInfo(payload.deviceInfo)) {
      await sendJson(ws, {
        type: "error",
        code: "invalid_message",
        message: "Invalid device info",
      });
      return;
    }
    const sanitizedInfo = sanitizeDeviceInfo(payload.deviceInfo);
    if (!sanitizedInfo.platform || !sanitizedInfo.model) {
      await sendJson(ws, {
        type: "error",
        code: "invalid_message",
        message: "Invalid device info",
      });
      return;
    }
    // Lowercase the claimed name for consistent routing (case-insensitive login)
    const sanitizedClaimedName = sanitizeLabel(payload.claimedName)?.toLowerCase();
    const normalizedUserId = normalizeUserIdFromClaimedName(sanitizedClaimedName);
    const deviceId = payload.deviceId;
    await refreshAllowlistFromDisk();
    const entry = findAllowlistEntry(deviceId);
    if (entry) {
      logger.info?.("[clawline:http] pair_request_allowlist_entry", {
        deviceId,
        isAdmin: entry.isAdmin,
        tokenDelivered: entry.tokenDelivered,
        lastSeenAt: entry.lastSeenAt,
      });
    }
    if (entry && !entry.tokenDelivered) {
      const token = issueToken(entry);
      const delivered = await sendJson(ws, {
        type: "pair_result",
        success: true,
        token,
        userId: entry.userId,
      });
      if (delivered) {
        await setTokenDelivered(deviceId, true);
      }
      ws.close();
      return;
    }
    if (entry && entry.tokenDelivered && entry.lastSeenAt === null) {
      const now = nowMs();
      const graceMs = config.auth.reissueGraceSeconds * 1000;
      if (now - entry.createdAt <= graceMs) {
        const token = issueToken(entry);
        const delivered = await sendJson(ws, {
          type: "pair_result",
          success: true,
          token,
          userId: entry.userId,
        });
        if (delivered) {
          await updateLastSeen(entry.deviceId, now);
        }
        ws.close();
        return;
      }
    }
    if (entry && entry.tokenDelivered) {
      // Check if user is switching accounts (different claimedName → different userId)
      const newUserId = normalizedUserId ?? entry.userId;
      const isSwitchingAccount = newUserId !== entry.userId;
      if (isSwitchingAccount) {
        logger.info?.("[clawline:http] pair_request_account_switch", {
          deviceId,
          oldUserId: entry.userId,
          newUserId,
        });
        const existingPendingEntry = findPendingEntry(deviceId);
        const pendingCount = pendingFile.entries.length + (existingPendingEntry ? 0 : 1);
        if (pendingCount > config.pairing.maxPendingRequests) {
          await sendJson(ws, {
            type: "error",
            code: "rate_limited",
            message: "Too many pending pair requests",
          });
          return;
        }
        const pendingEntry: PendingEntry = {
          deviceId,
          claimedName: sanitizedClaimedName,
          deviceInfo: sanitizedInfo,
          requestedAt: existingPendingEntry ? existingPendingEntry.requestedAt : nowMs(),
        };
        await upsertPendingEntry(pendingEntry);
        await notifyGatewayOfPending(pendingEntry).catch(() => {});
        await sendJson(ws, { type: "pair_result", success: false, reason: "pair_pending" });
        ws.close();
        return;
      } else {
        logger.info?.("[clawline:http] pair_request_token_redispatch", { deviceId });
      }
      const token = issueToken(entry);
      const delivered = await sendJson(ws, {
        type: "pair_result",
        success: true,
        token,
        userId: entry.userId,
      });
      if (delivered) {
        await updateLastSeen(entry.deviceId, nowMs());
        await setTokenDelivered(entry.deviceId, true);
      }
      ws.close();
      return;
    }

    const existingPendingEntry = findPendingEntry(deviceId);
    const pendingCount = pendingFile.entries.length + (existingPendingEntry ? 0 : 1);
    if (pendingCount > config.pairing.maxPendingRequests) {
      await sendJson(ws, {
        type: "error",
        code: "rate_limited",
        message: "Too many pending requests",
      });
      ws.close(1008);
      return;
    }
    const now = nowMs();
    const pendingEntry: PendingEntry = {
      deviceId,
      claimedName: sanitizedClaimedName,
      deviceInfo: sanitizedInfo,
      requestedAt: existingPendingEntry ? existingPendingEntry.requestedAt : now,
    };
    logger.info?.("[clawline:http] pair_request_upsert_pending", {
      deviceId,
      claimedName: sanitizedClaimedName,
      pendingCount: pendingFile.entries.length + (existingPendingEntry ? 0 : 1),
    });
    await upsertPendingEntry(pendingEntry);
    logger.info?.("[clawline:http] pair_request_pending_persisted", {
      deviceId,
      pendingEntries: pendingFile.entries.length,
    });
    notifyGatewayOfPending(pendingEntry)
      .then(() =>
        logger.info?.("[clawline:http] pair_request_pending_notified", {
          deviceId,
          claimedName: pendingEntry.claimedName,
          platform: pendingEntry.deviceInfo.platform,
        }),
      )
      .catch((err) =>
        logger.warn?.("[clawline:http] pair_request_pending_notify_failed", {
          deviceId,
          error: err.message,
        }),
      );
    const existingSocket = pendingSockets.get(deviceId);
    if (existingSocket) {
      existingSocket.socket.close(1000);
    }
    pendingSockets.set(deviceId, {
      deviceId,
      socket: ws,
      claimedName: sanitizedClaimedName,
      deviceInfo: sanitizedInfo,
      createdAt: now,
    });
    await sendJson(ws, { type: "pair_result", success: false, reason: "pair_pending" }).catch(
      () => {},
    );
  }

  // oxlint-disable-next-line typescript/no-explicit-any
  async function handleAuth(ws: WebSocket, payload: any) {
    if (payload.protocolVersion !== PROTOCOL_VERSION) {
      await sendJson(ws, {
        type: "error",
        code: "invalid_message",
        message: "Unsupported protocol",
      });
      ws.close();
      return;
    }
    if (typeof payload.token !== "string" || !validateDeviceId(payload.deviceId)) {
      await sendJson(ws, { type: "auth_result", success: false, reason: "auth_failed" });
      ws.close();
      return;
    }
    if (pendingSockets.has(payload.deviceId)) {
      await sendJson(ws, { type: "auth_result", success: false, reason: "device_not_approved" });
      ws.close();
      return;
    }
    if (!authRateLimiter.attempt(payload.deviceId)) {
      await sendJson(ws, { type: "auth_result", success: false, reason: "rate_limited" });
      ws.close(1008);
      return;
    }
    let decoded: jwt.JwtPayload;
    try {
      decoded = jwt.verify(payload.token, jwtKey, { algorithms: ["HS256"] }) as jwt.JwtPayload;
    } catch {
      await sendJson(ws, { type: "auth_result", success: false, reason: "auth_failed" });
      ws.close();
      return;
    }
    if (
      typeof decoded.deviceId !== "string" ||
      !timingSafeStringEqual(decoded.deviceId, payload.deviceId)
    ) {
      await sendJson(ws, { type: "auth_result", success: false, reason: "auth_failed" });
      ws.close();
      return;
    }
    const entry = findAllowlistEntry(payload.deviceId);
    if (!entry) {
      await sendJson(ws, { type: "auth_result", success: false, reason: "auth_failed" });
      ws.close();
      return;
    }
    if (typeof decoded.sub !== "string" || !timingSafeStringEqual(decoded.sub, entry.userId)) {
      await sendJson(ws, { type: "auth_result", success: false, reason: "auth_failed" });
      ws.close();
      return;
    }
    if (isDenylisted(entry.deviceId)) {
      await sendJson(ws, { type: "auth_result", success: false, reason: "token_revoked" });
      ws.close();
      return;
    }
    const peerId = derivePeerId(entry);
    const clientFeatures = parseClientFeatures(payload);
    const session: Session = {
      socket: ws,
      deviceId: entry.deviceId,
      userId: entry.userId,
      isAdmin: entry.isAdmin,
      clientFeatures,
      sessionId: `session_${randomUUID()}`,
      sessionKey: "",
      sessionKeys: [],
      provisionedSessionKeys: [],
      personalSessionKey: "",
      dmScope: "main",
      dmSessionKey: "",
      globalSessionKey: "",
      peerId,
      claimedName: entry.claimedName,
      deviceInfo: entry.deviceInfo,
    };
    applySessionInfo(session, entry.isAdmin);
    registerSession(session);
    connectionState.set(ws, {
      authenticated: true,
      deviceId: session.deviceId,
      userId: session.userId,
      isAdmin: session.isAdmin,
      sessionId: session.sessionId,
    });
    try {
      await updateLastSeen(session.deviceId, nowMs());
      const lastMessageId =
        typeof payload.lastMessageId === "string" ? payload.lastMessageId : null;
      logger.info("replay_request", {
        deviceId: session.deviceId,
        userId: session.userId,
        lastMessageId: lastMessageId ?? "(null)",
      });
      if (
        typeof payload.lastMessageId === "string" &&
        !SERVER_EVENT_ID_REGEX.test(payload.lastMessageId)
      ) {
        await sendJson(ws, {
          type: "error",
          code: "invalid_message",
          message: "Invalid lastMessageId",
        });
        ws.close();
        return;
      }
      await sendReplay(session, lastMessageId);
    } catch {
      removeSession(session);
      connectionState.delete(ws);
      await sendJson(ws, { type: "error", code: "server_error", message: "Replay failed" }).catch(
        () => {},
      );
      ws.close(1011);
      return;
    }
  }

  // oxlint-disable-next-line typescript/no-explicit-any
  async function handleAuthedMessage(ws: WebSocket, payload: any) {
    const state = connectionState.get(ws);
    if (!state || !state.authenticated || !state.deviceId || !state.userId) {
      await sendJson(ws, { type: "error", code: "auth_failed", message: "Not authenticated" });
      ws.close();
      return;
    }
    const session = sessionsByDevice.get(state.deviceId);
    if (!session) {
      await sendJson(ws, { type: "error", code: "auth_failed", message: "Session missing" });
      return;
    }
    await processClientMessage(session, payload);
  }

  // oxlint-disable-next-line typescript/no-explicit-any
  async function handleAuthedInteractiveCallback(ws: WebSocket, payload: any) {
    const state = connectionState.get(ws);
    if (!state || !state.authenticated || !state.deviceId || !state.userId) {
      await sendJson(ws, { type: "error", code: "auth_failed", message: "Not authenticated" });
      ws.close();
      return;
    }
    const session = sessionsByDevice.get(state.deviceId);
    if (!session) {
      await sendJson(ws, { type: "error", code: "auth_failed", message: "Session missing" });
      return;
    }
    await processInteractiveCallback(session, payload);
  }

  let started = false;

  const readBoundPort = () => {
    const addr = httpServer.address();
    if (!addr || typeof addr === "string") {
      return config.port;
    }
    return addr.port;
  };

  return {
    async start() {
      const initialized = initializeDatabaseResources();
      if (initialized) {
        await cleanupTmpDirectory();
        await cleanupOrphanedAssetFiles();
      }
      cleanupExpiredStreamIdempotencyRows();
      if (!streamIdempotencyCleanupInterval) {
        streamIdempotencyCleanupInterval = setInterval(() => {
          cleanupExpiredStreamIdempotencyRows();
        }, STREAM_IDEMPOTENCY_CLEANUP_INTERVAL_MS);
      }
      if (started) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          httpServer.removeListener("error", onError);
          reject(err);
        };
        httpServer.once("error", onError);
        httpServer.listen(config.port, config.network.bindAddress, () => {
          httpServer.removeListener("error", onError);
          resolve();
        });
      });
      started = true;
      const port = readBoundPort();
      logger.info(`Provider listening on ${config.network.bindAddress}:${port}`);
    },
    async stop() {
      if (!started) {
        return;
      }
      allowlistWatcher.close();
      pendingFileWatcher.close();
      denylistWatcher.close();
      clearInterval(pendingCleanupInterval);
      if (assetCleanupInterval) {
        clearInterval(assetCleanupInterval);
      }
      if (streamIdempotencyCleanupInterval) {
        clearInterval(streamIdempotencyCleanupInterval);
        streamIdempotencyCleanupInterval = null;
      }
      // Force-close any active clients so shutdown doesn't hang.
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {
          // ignore
        }
      }
      for (const client of terminalWss.clients) {
        try {
          client.terminate();
        } catch {
          // ignore
        }
      }
      for (const socket of sockets) {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      }
      httpServer.closeIdleConnections?.();
      httpServer.closeAllConnections?.();
      const closeWithTimeout = (fn: (cb: () => void) => void, label: string) =>
        new Promise<void>((resolve) => {
          let resolved = false;
          const timer = setTimeout(() => {
            if (!resolved) {
              resolved = true;
              logger.warn("shutdown_timeout", { label });
              resolve();
            }
          }, 5000);
          fn(() => {
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              resolve();
            }
          });
        });
      await closeWithTimeout((cb) => wss.close(cb), "wss");
      await closeWithTimeout((cb) => terminalWss.close(cb), "terminalWss");
      await closeWithTimeout((cb) => httpServer.close(cb), "httpServer");
      await perUserTaskQueue.drain();
      await writeQueue.catch(() => {});
      disposeDatabaseResources();
      started = false;
    },
    getPort() {
      return readBoundPort();
    },
    sendMessage: sendOutboundMessage,
  };
}
