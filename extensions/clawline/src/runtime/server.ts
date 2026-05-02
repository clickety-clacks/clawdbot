import { execFile as execFileCb } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Stats } from "node:fs";
import { watch, type FSWatcher, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Database as SqliteDatabase, Statement as SqliteStatement } from "better-sqlite3";
import BetterSqlite3 from "better-sqlite3";
import jwt from "jsonwebtoken";
import { loadGatewayTlsRuntime } from "openclaw/plugin-sdk/gateway-runtime";
import { type Dispatcher } from "undici";
import WebSocket, { WebSocketServer } from "ws";
import {
  DEFAULT_ACCOUNT_ID,
  closeDispatcher,
  createPinnedDispatcher,
  createReplyDispatcherWithTyping,
  detectMime,
  dispatchInboundMessage,
  enqueueAnnounce,
  finalizeInboundContext,
  hasAlphaChannel,
  isLoopbackHost,
  isPrivateOrLoopbackHost,
  loadSessionStore,
  maxBytesForKind,
  mediaKindFromMime,
  optimizeImageToJpeg,
  optimizeImageToPng,
  parseAgentSessionKey,
  rawDataToString,
  recordInboundSession,
  resolveAgentIdentity,
  resolveAgentIdFromSessionKey,
  resolveAllAgentSessionStoreTargetsSync,
  resolveDefaultModelForAgent,
  resolveEffectiveMessagesConfig,
  resolveHumanDelayConfig,
  resolveSessionStoreEntry,
  resolvePinnedHostname,
  updateSessionStore,
  applySessionsPatchToStore,
  buildAllowedModelSet,
  loadModelCatalog,
  type PinnedHostname,
  type ReplyPayload,
} from "../runtime-api.js";
import { clawlineAttachmentsToImages } from "./attachments.js";
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
  StreamReadStateServerMessage,
  StreamTailState,
  StreamTailStateServerMessage,
} from "./domain.js";
import { ClientMessageError, HttpError } from "./errors.js";
import { callClawlineGatewayAgent } from "./gateway-alert-runtime.js";
import { createAssetHandlers } from "./http-assets.js";
import { runWithClawlineOutboundCorrelation } from "./outbound.js";
import { createPerUserTaskQueue } from "./per-user-task-queue.js";
import { SlidingWindowRateLimiter } from "./rate-limiter.js";
import {
  type ClawlineResponsePrefixContext,
  extractClawlineShortModelName,
  getClawlineFollowupQueueDepth,
  resolveClawlineQueueSettings,
} from "./reply-compat.js";
import { ClawlineDeliveryTarget } from "./routing.js";
import {
  CLAWLINE_DEFAULT_AGENT_WORKSPACE_DIR,
  isClawlineCronRunSessionKey,
  resolveClawlineSessionTranscriptPath,
  type ClawlineSessionEntry,
} from "./session-compat.js";
import { resolveSubscribedSessionKeys } from "./session-keys.js";
import { recordClawlineSessionActivity } from "./session-store.js";
import { peekSystemEvents } from "./system-events.js";
import { deepMerge } from "./utils/deep-merge.js";

export const PROTOCOL_VERSION = 1;

const execFile = promisify(execFileCb);
type SessionEntry = ClawlineSessionEntry;

type ClientPayload = Record<string, unknown>;

type PtyProcess = {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: { exitCode?: number }) => void): void;
};

function isClientPayload(value: unknown): value is ClientPayload {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

type TerminalTmuxBackend = {
  execTmux(
    args: string[],
    options: { timeout: number; maxBuffer: number },
  ): Promise<{
    stdout: unknown;
  }>;
  spawnAttachPty(params: { sessionName: string; cols: number; rows: number }): Promise<{
    pty: PtyProcess;
  }>;
};

type TerminalDestination = {
  address: string;
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

function createTerminalTmuxBackend(
  config: ProviderConfig,
  logger: Logger,
  destinationAddress?: string | null,
): TerminalTmuxBackend {
  const sshCfg = config.terminal?.tmux?.ssh;
  const explicitTarget = typeof destinationAddress === "string" ? destinationAddress.trim() : "";
  const tmuxMode = explicitTarget ? "ssh" : (config.terminal?.tmux?.mode ?? "local");
  const sshTarget =
    explicitTarget || (typeof sshCfg?.target === "string" ? sshCfg.target.trim() : "");
  const sshBaseArgs = sshCfg ? buildSshBaseArgs(sshCfg) : [];

  const isRemote = tmuxMode === "ssh";
  if (isRemote && !sshTarget) {
    logger.warn?.(
      "[clawline:terminal] tmux remote mode enabled but ssh target is empty; falling back to local",
    );
  }

  const useRemote = isRemote && sshTarget.length > 0;

  /**
   * Shell-quote a single argument for safe insertion into a remote shell command string.
   * SSH concatenates args after the host with spaces and passes the result to the remote
   * shell. Characters like `#` (comment in zsh non-interactive mode) can silently swallow
   * subsequent arguments. Single-quoting every arg prevents all shell interpretation.
   */
  function shellQuoteArg(arg: string): string {
    // Wrap in single quotes, escaping any embedded single quotes as '"'"''.
    return "'" + arg.replace(/'/g, "'\\''") + "'";
  }

  return {
    async execTmux(args: string[], options: { timeout: number; maxBuffer: number }) {
      if (!useRemote) {
        return execFile("tmux", args, options);
      }
      // Build a single quoted shell command so special chars (e.g. `#` in tmux format
      // strings like `#{pane_id}`) are not misinterpreted by the remote shell.
      const remoteCmd = "LANG=en_US.UTF-8 " + ["tmux", ...args].map(shellQuoteArg).join(" ");
      return execFile("ssh", [...sshBaseArgs, sshTarget, remoteCmd], options);
    },
    async spawnAttachPty(params: { sessionName: string; cols: number; rows: number }) {
      const ptyModule = (await import("@lydell/node-pty")) as unknown as {
        spawn: (
          file: string,
          args: string[],
          options: { name: string; cols: number; rows: number },
        ) => PtyProcess;
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
      const remoteCmd =
        "LANG=en_US.UTF-8 " +
        ["tmux", "attach-session", "-t", params.sessionName].map(shellQuoteArg).join(" ");
      const sshArgs = ["-tt", ...sshBaseArgs, sshTarget, remoteCmd];
      const pty = ptyModule.spawn("ssh", sshArgs, {
        name: "xterm-256color",
        cols: params.cols,
        rows: params.rows,
      });
      return { pty };
    },
  };
}

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
const SERVER_FEATURE_STREAM_READ_STATE = "stream_read_state";
const SERVER_FEATURE_STREAM_TAIL_STATE = "stream_tail_state";
const TERMINAL_BUBBLES_UNSUPPORTED_NOTICE =
  "Terminal session hidden: this client does not support terminal bubbles yet. Update Clawline to view it.";
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
const STREAM_DB_VERSION = 5;
const STREAM_SUFFIX_REGEX = /^s_[0-9a-f]{8}$/;
const STREAM_DISPLAY_NAME_FALLBACK = "Stream";
const STREAM_IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const STREAM_IDEMPOTENCY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const STREAM_OPERATION_CREATE = "create_stream";
const STREAM_OPERATION_DELETE = "delete_stream";
const MAX_STREAMS_BODY_BYTES = 16 * 1024;
const STREAM_SESSION_KEY_PATH_DECODE_PASSES = 4;

function stripControlChars(value: string): string {
  let result = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      continue;
    }
    result += char;
  }
  return result;
}

type ClawlineAnnounceQueueItem = {
  announceId?: string;
  attachments?: unknown[];
  prompt: string;
  summaryLine?: string;
  enqueuedAt: number;
  sessionKey: string;
  origin?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
};

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

function parseAdoptedSessionKeys(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const record = payload as { adoptedSessionKeys?: unknown };
  if (!Array.isArray(record.adoptedSessionKeys)) {
    return [];
  }
  const deduped = new Map<string, string>();
  for (const item of record.adoptedSessionKeys) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }
    deduped.set(trimmed.toLowerCase(), trimmed.toLowerCase());
  }
  return [...deduped.values()];
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

function countTerminalSessionDocumentAttachments(values?: unknown[]): number {
  if (!Array.isArray(values) || values.length === 0) {
    return 0;
  }
  let count = 0;
  for (const value of values) {
    if (isTerminalSessionDocumentAttachment(value)) {
      count += 1;
    }
  }
  return count;
}

function buildAuthResultFeatures(session: Session): string[] {
  const features = [
    SERVER_FEATURE_SESSION_INFO,
    SERVER_FEATURE_STREAM_READ_STATE,
    SERVER_FEATURE_STREAM_TAIL_STATE,
  ];
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
  let strippedTerminalAttachments = 0;
  if (
    Array.isArray(attachments) &&
    attachments.length > 0 &&
    !session.clientFeatures.has(CLIENT_FEATURE_TERMINAL_BUBBLES_V1)
  ) {
    const filtered = attachments.filter((attachment) => {
      if (isTerminalSessionDocumentAttachment(attachment)) {
        strippedTerminalAttachments += 1;
        return false;
      }
      return true;
    });
    attachments = filtered.length > 0 ? filtered : undefined;
  }
  let content = payload.content;
  if (strippedTerminalAttachments > 0 && !content.includes(TERMINAL_BUBBLES_UNSUPPORTED_NOTICE)) {
    const trimmed = content.trim();
    content = trimmed
      ? `${content}\n\n${TERMINAL_BUBBLES_UNSUPPORTED_NOTICE}`
      : TERMINAL_BUBBLES_UNSUPPORTED_NOTICE;
  }
  return {
    ...payload,
    sessionKey: effectiveSessionKey,
    content,
    attachments,
  };
}

function sanitizeLabel(label?: string): string | undefined {
  if (typeof label !== "string") {
    return undefined;
  }
  const stripped = stripControlChars(label).trim();
  if (!stripped) {
    return undefined;
  }
  return truncateUtf8(stripped, 64);
}

function sanitizeStreamDisplayName(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const stripped = stripControlChars(value).trim();
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
    const stripped = stripControlChars(value).trim();
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
  const source = [
    entry.bindingId?.trim(),
    entry.claimedName?.trim(),
    entry.deviceInfo.model?.trim(),
    entry.deviceInfo.platform?.trim(),
    entry.userId.trim(),
    entry.deviceId.trim(),
  ].find((value): value is string => typeof value === "string" && value.length > 0);
  return source ?? entry.deviceId;
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

function canonicalizeReplayAttachments(
  attachments: unknown,
  logger: Logger,
  messageId?: string,
): NormalizedAttachment[] | undefined {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return undefined;
  }
  const canonical: NormalizedAttachment[] = [];
  let rewroteMixedShape = false;
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") {
      continue;
    }
    const typed = attachment as {
      type?: unknown;
      mimeType?: unknown;
      data?: unknown;
      assetId?: unknown;
    };
    const assetId = typeof typed.assetId === "string" ? typed.assetId.trim() : "";
    if (ASSET_ID_REGEX.test(assetId)) {
      canonical.push({ type: "asset", assetId });
      if (typed.type === "image" || typed.type === "document" || typeof typed.data === "string") {
        rewroteMixedShape = true;
      }
      continue;
    }
    if (
      typed.type === "image" &&
      typeof typed.mimeType === "string" &&
      typeof typed.data === "string"
    ) {
      canonical.push({
        type: "image",
        mimeType: typed.mimeType,
        data: typed.data,
      });
      continue;
    }
    if (
      typed.type === "document" &&
      typeof typed.mimeType === "string" &&
      typeof typed.data === "string"
    ) {
      canonical.push({
        type: "document",
        mimeType: typed.mimeType,
        data: typed.data,
      });
    }
  }
  if (rewroteMixedShape) {
    logger.warn?.("[clawline] replay_attachment_canonicalized", {
      messageId,
      attachmentCount: canonical.length,
    });
  }
  return canonical.length > 0 ? canonical : undefined;
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

function normalizeTerminalDestination(value: unknown): TerminalDestination | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const address =
    typeof (value as { address?: unknown }).address === "string"
      ? (value as { address: string }).address.trim()
      : "";
  if (!address) {
    return undefined;
  }
  return { address };
}

function decodeTerminalSessionDescriptorFromBase64(data: string): {
  terminalSessionId: string;
  title?: string;
  version?: number;
  destination?: TerminalDestination;
} | null {
  try {
    const decoded = Buffer.from(data, "base64").toString("utf8");
    const obj = JSON.parse(decoded) as {
      terminalSessionId?: unknown;
      title?: unknown;
      version?: unknown;
      destination?: unknown;
    };
    const id = typeof obj.terminalSessionId === "string" ? obj.terminalSessionId.trim() : "";
    if (!id) {
      return null;
    }
    const title =
      typeof obj.title === "string" && obj.title.trim().length > 0 ? obj.title.trim() : undefined;
    const version =
      typeof obj.version === "number" && Number.isFinite(obj.version)
        ? Math.floor(obj.version)
        : undefined;
    const destination = normalizeTerminalDestination(obj.destination);
    if (version === 2 && !destination) {
      return null;
    }
    return { terminalSessionId: id, title, version, destination };
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
  /** Non-native session keys adopted by this user and merged into routing/subscriptions. */
  adoptedSessionKeys: string[];
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
  replayInProgress: boolean;
  replayDeliveredMessageIds: Set<string>;
  replayBufferedMessages: ServerMessage[];
  replayBarrier: Promise<void>;
  resolveReplayBarrier: () => void;
  revoked: boolean;
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
  clientMessageId?: string;
  replyToMessageId?: string;
  replyToClientMessageId?: string;
};

type StreamServerMessage =
  | StreamSnapshotServerMessage
  | StreamCreatedServerMessage
  | StreamUpdatedServerMessage
  | StreamDeletedServerMessage
  | StreamReadStateServerMessage
  | StreamTailStateServerMessage;

type StreamTailStateRow = {
  sessionKey: string;
  payloadJson: string;
};

type TrackableSessionApiEntry = {
  sessionKey: string;
  displayName: string;
  updatedAt: number;
  channel?: string;
  lastChannel?: string;
  lastTo?: string;
};

type SessionStatusActiveRun = {
  runId: string;
  messageId: string;
  sessionKey: string;
  startedAt: number;
  provider: string | null;
  model: string | null;
  thinkingLevel: string | null;
  fastMode: boolean | null;
};

type SessionStatusRuntimeSnapshot = {
  provider: string | null;
  model: string | null;
  thinkingLevel: string | null;
  fastMode: boolean | null;
};

type AdoptedSessionRow = {
  userId: string;
  sessionKey: string;
  createdAt: number;
};
type StreamSessionRow = {
  userId: string;
  sessionKey: string;
  displayName: string;
  kind: StreamSessionKind;
  orderIndex: number;
  isBuiltIn: number;
  adopted: number;
  createdAt: number;
  updatedAt: number;
};

type StreamReadStateRow = {
  userId: string;
  sessionKey: string;
  lastReadMessageId: string;
  lastReadSequence: number;
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
  destination?: TerminalDestination;
};

export const DEFAULT_ALERT_INSTRUCTIONS_TEXT = `After handling this alert, evaluate: would Flynn want to know what happened? If yes, report to him. Don't just process silently.`;
export const MAIN_SESSION_ALERT_REPLY_TEXT =
  "Reply with one brief visible update to Flynn for this alert. Do not answer with NO_REPLY.";

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
  server: {
    cluSecret: null,
  },
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
  webRootPath: path.join(CLAWLINE_DEFAULT_AGENT_WORKSPACE_DIR, "www"),
  webRoot: {
    followSymlinks: false,
  },
  sessions: {
    maxMessageBytes: 65_536,
    maxReplayMessages: 500,
    maxReplayMessagesPerStream: 20,
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

function describePairingEntry(entry: {
  deviceId: string;
  claimedName?: string;
  deviceInfo?: Partial<DeviceInfo> | null;
}): string {
  const name = entry.claimedName?.trim() || "New device";
  const platform = entry.deviceInfo?.platform?.trim() || "Unknown platform";
  const model = entry.deviceInfo?.model?.trim();
  const surface = model && model !== platform ? `${platform}/${model}` : platform;
  return `${name} (${surface}) [deviceId: ${entry.deviceId}]`;
}

const CLAWLINE_ALLOWED_ORIGINS_SETTING = "channels.clawline.network.allowedOrigins";

type ClawlineBrowserOriginCheckResult =
  | {
      ok: true;
      matchedBy: "allowlist" | "no-origin" | "private-network" | "tailnet";
      origin: string | null;
    }
  | { ok: false; origin: string | null; reason: string };

function parseClawlineBrowserOrigin(
  originHeader?: string,
):
  | { kind: "missing" }
  | { kind: "opaque"; origin: string }
  | { kind: "origin"; origin: string; hostname: string }
  | { kind: "invalid"; origin: string } {
  const trimmed = originHeader?.trim();
  if (!trimmed) {
    return { kind: "missing" };
  }
  if (trimmed === "null") {
    return { kind: "opaque", origin: "null" };
  }
  try {
    const url = new URL(trimmed);
    return {
      kind: "origin",
      origin: url.origin.toLowerCase(),
      hostname: url.hostname.toLowerCase(),
    };
  } catch {
    return { kind: "invalid", origin: trimmed };
  }
}

function checkClawlineBrowserOrigin(params: {
  originHeader?: string;
  allowedOrigins?: string[];
}): ClawlineBrowserOriginCheckResult {
  const parsed = parseClawlineBrowserOrigin(params.originHeader);
  if (parsed.kind === "missing") {
    return {
      ok: true,
      matchedBy: "no-origin",
      origin: null,
    };
  }

  const allowlist = new Set(
    (params.allowedOrigins ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean),
  );

  if (parsed.kind === "opaque") {
    if (allowlist.has(parsed.origin)) {
      return {
        ok: true,
        matchedBy: "allowlist",
        origin: parsed.origin,
      };
    }
    return {
      ok: false,
      origin: parsed.origin,
      reason: `Opaque browser origins are not accepted automatically. Add "null" to ${CLAWLINE_ALLOWED_ORIGINS_SETTING} if this is intentional.`,
    };
  }

  if (parsed.kind === "invalid") {
    return {
      ok: false,
      origin: parsed.origin,
      reason: `Browser Origin header is invalid. Use a valid local/private/tailnet origin or add the exact public origin to ${CLAWLINE_ALLOWED_ORIGINS_SETTING}.`,
    };
  }

  if (allowlist.has(parsed.origin)) {
    return {
      ok: true,
      matchedBy: "allowlist",
      origin: parsed.origin,
    };
  }

  if (parsed.hostname.endsWith(".ts.net")) {
    return {
      ok: true,
      matchedBy: "tailnet",
      origin: parsed.origin,
    };
  }

  if (isLoopbackHost(parsed.hostname) || isPrivateOrLoopbackHost(parsed.hostname)) {
    return {
      ok: true,
      matchedBy: "private-network",
      origin: parsed.origin,
    };
  }

  return {
    ok: false,
    origin: parsed.origin,
    reason: `Browser origin ${parsed.origin} is not allowed. Local/private/tailnet origins are accepted automatically, but public origins must be listed explicitly in ${CLAWLINE_ALLOWED_ORIGINS_SETTING}.`,
  };
}

function buildRejectedOriginUpgradeResponse(reason: string): string {
  const body = `${reason}\n`;
  return [
    "HTTP/1.1 403 Forbidden",
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body, "utf8")}`,
    "Connection: close",
    "",
    body,
  ].join("\r\n");
}

const STREAM_API_CORS_ALLOW_METHODS = "GET, POST, PATCH, DELETE, OPTIONS";
const STREAM_API_CORS_ALLOW_HEADERS = "Authorization, Content-Type";

function appendVaryHeader(res: http.ServerResponse, value: string) {
  const current = res.getHeader("Vary");
  const existingValues = Array.isArray(current)
    ? current
    : typeof current === "string"
      ? current.split(",")
      : [];
  const normalized = new Set(
    existingValues.map((entry) => entry.trim()).filter((entry) => entry.length > 0),
  );
  normalized.add(value);
  res.setHeader("Vary", [...normalized].join(", "));
}

function applyStreamApiCorsHeaders(res: http.ServerResponse, origin: string | null) {
  if (!origin) {
    return;
  }
  appendVaryHeader(res, "Origin");
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", STREAM_API_CORS_ALLOW_METHODS);
  res.setHeader("Access-Control-Allow-Headers", STREAM_API_CORS_ALLOW_HEADERS);
  res.setHeader("Access-Control-Max-Age", "600");
}

function isStreamApiPath(pathName: string): boolean {
  return (
    pathName === "/api/streams" ||
    pathName.startsWith("/api/streams/") ||
    pathName === "/api/trackable-sessions" ||
    pathName === "/api/session-status" ||
    pathName === "/api/session-control"
  );
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
  const parts = attachments.map((attachment): string => {
    switch (attachment.type) {
      case "image":
        return `{"type":"image","mimeType":${quote(attachment.mimeType)},"data":${quote(attachment.data)}}`;
      case "document":
        return `{"type":"document","mimeType":${quote(attachment.mimeType)},"data":${quote(attachment.data)}}`;
      case "asset":
        return `{"type":"asset","assetId":${quote(attachment.assetId)}}`;
      default: {
        const exhaustiveCheck: never = attachment;
        throw new Error(`Unsupported Clawline attachment: ${JSON.stringify(exhaustiveCheck)}`);
      }
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
  const sessionStorePath = options.sessionStorePath;
  const mainSessionKey = options.mainSessionKey?.trim() || "agent:main:main";
  const mainSessionAgentId = resolveAgentIdFromSessionKey(mainSessionKey);

  const resolveIdentityName = (agentId: string) => {
    const name = resolveAgentIdentity(openClawCfg, agentId)?.name;
    return typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined;
  };
  const resolveAssistantSenderName = (sessionKey: string) =>
    resolveIdentityName(resolveAgentIdFromSessionKey(sessionKey));
  const activeSessionRuns = new Map<string, SessionStatusActiveRun>();
  const sessionRuntimeStatusSnapshots = new Map<string, SessionStatusRuntimeSnapshot>();

  type SessionInfo = {
    dmScope: string;
    mainSessionKey: string;
    dmSessionKey: string;
    globalSessionKey: string;
    /** Stream-only session keys reported to the client in auth/session_info payloads. */
    streamSessionKeys: string[];
    /** Adopted non-native session keys merged into inbound/outbound provider routing. */
    adoptedSessionKeys: string[];
    /** All provisioned session keys (may include admin-only keys). */
    provisionedSessionKeys: string[];
    /** Session keys this socket is subscribed to for outbound delivery. */
    subscribedSessionKeys: string[];
  };

  const normalizeSessionKey = (key: string) => key.trim().toLowerCase();
  const sessionKeyEq = (a: string, b: string) => normalizeSessionKey(a) === normalizeSessionKey(b);
  const dedupeKeys = (keys: string[]) =>
    Array.from(new Map(keys.map((key) => [normalizeSessionKey(key), key])).values());

  const buildSessionInfo = (
    userId: string,
    isAdmin: boolean,
    adoptedSessionKeysInput: string[] = [],
  ) => {
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
    const streamSessionKeys = dedupeKeys(
      visibleStreamKeys.length > 0 ? visibleStreamKeys : fallbackKeys,
    );
    const adoptedSessionKeys = dedupeKeys(adoptedSessionKeysInput);
    const provisionedSessionKeys = dedupeKeys([...streamSessionKeys, ...adoptedSessionKeys]);
    const subscribedSessionKeys = provisionedSessionKeys;

    return {
      dmScope,
      mainSessionKey: mainStreamSessionKey,
      dmSessionKey,
      globalSessionKey,
      streamSessionKeys,
      adoptedSessionKeys,
      provisionedSessionKeys,
      subscribedSessionKeys,
    } satisfies SessionInfo;
  };
  const applySessionInfo = (
    session: Session,
    isAdmin: boolean,
    adoptedSessionKeys: string[] = [],
  ) => {
    const info = buildSessionInfo(session.userId, isAdmin, adoptedSessionKeys);
    session.isAdmin = isAdmin;
    session.personalSessionKey = info.mainSessionKey;
    session.dmScope = info.dmScope;
    session.dmSessionKey = info.dmSessionKey;
    session.globalSessionKey = info.globalSessionKey;
    session.adoptedSessionKeys = info.adoptedSessionKeys;
    session.provisionedSessionKeys = info.provisionedSessionKeys;
    session.sessionKeys = info.subscribedSessionKeys;
    session.sessionKey = info.mainSessionKey;
    return info;
  };
  const sendSessionInfo = async (
    session: Session,
    info?: ReturnType<typeof buildSessionInfo>,
  ): Promise<boolean> => {
    const resolved =
      info ?? buildSessionInfo(session.userId, session.isAdmin, session.adoptedSessionKeys);
    const payload = {
      type: "session_info",
      userId: session.userId,
      isAdmin: session.isAdmin,
      dmScope: resolved.dmScope,
      sessionKeys: resolved.streamSessionKeys,
      streamReadStates: readStreamReadStatesForUser(session.userId, resolved.streamSessionKeys),
      streamTailStates: readStreamTailStatesForUser(session.userId, resolved.streamSessionKeys),
    };
    return sendJson(session.socket, payload).catch(() => false);
  };
  async function notifyGatewayOfPending(entry: PendingEntry) {
    const text = `New device pending approval: ${describePairingEntry(entry)}`;
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
  const explicitPublicOrigins = (config.network.allowedOrigins ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value && value !== "null");
  if (
    config.network.allowInsecurePublic &&
    !isLocalhost(config.network.bindAddress) &&
    explicitPublicOrigins.length === 0
  ) {
    logger.warn?.(
      `[clawline] binding non-loopback without explicit public browser origins; local/private/tailnet origins will be accepted automatically, but public browser origins must be added to ${CLAWLINE_ALLOWED_ORIGINS_SETTING}`,
    );
  }
  const providerTls = await loadGatewayTlsRuntime(openClawCfg.gateway?.tls);
  if (openClawCfg.gateway?.tls?.enabled === true && !providerTls.enabled) {
    throw new Error(providerTls.error ?? "gateway tls: failed to enable");
  }
  if (!providerTls.enabled && !isLocalhost(config.network.bindAddress)) {
    logger.warn?.(
      "[clawline] gateway.tls.enabled is false while binding non-loopback; provider WebSocket traffic will be plaintext ws://",
    );
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
  let updateActiveMessagesStreamingByDeviceStmt!: SqliteStatement;
  let insertMessageAssetStmt!: SqliteStatement;
  let insertAssetStmt!: SqliteStatement;
  let selectAssetStmt!: SqliteStatement;
  let selectExpiredAssetsStmt!: SqliteStatement;
  let deleteAssetStmt!: SqliteStatement;
  let selectEventsTailStmt!: SqliteStatement;
  let selectEventsTailBySessionStmt!: SqliteStatement;
  let selectEventsAfterBySessionStmt!: SqliteStatement;
  let selectEventByIdStmt!: SqliteStatement;
  let selectEventPayloadForUserStmt!: SqliteStatement;
  let selectStreamSessionsByUserStmt!: SqliteStatement;
  let selectStreamSessionByKeyStmt!: SqliteStatement;
  let selectStreamMaxOrderStmt!: SqliteStatement;
  let insertStreamSessionStmt!: SqliteStatement;
  let updateStreamSessionDisplayNameStmt!: SqliteStatement;
  let updateStreamSessionBuiltInMetadataStmt!: SqliteStatement;
  let deleteStreamSessionStmt!: SqliteStatement;
  let selectStreamReadStatesByUserStmt!: SqliteStatement;
  let selectStreamReadStateBySessionStmt!: SqliteStatement;
  let upsertStreamReadStateStmt!: SqliteStatement;
  let deleteStreamReadStateBySessionStmt!: SqliteStatement;
  let selectStreamIdempotencyStmt!: SqliteStatement;
  let insertStreamIdempotencyStmt!: SqliteStatement;
  let deleteExpiredStreamIdempotencyStmt!: SqliteStatement;
  let selectAdoptedSessionKeysByUserStmt!: SqliteStatement;
  let insertAdoptedSessionStmt!: SqliteStatement;
  let selectStreamTailStatesByUserStmt!: SqliteStatement;
  let deleteMessageAssetsBySessionStmt!: SqliteStatement;
  let deleteMessagesBySessionStmt!: SqliteStatement;
  let deleteEventsBySessionStmt!: SqliteStatement;
  let selectOrphanedAssetsForUserStmt!: SqliteStatement;
  let deleteOrphanedAssetByIdStmt!: SqliteStatement;
  let insertUserMessageTx!: (
    session: Session,
    targetUserId: string,
    messageId: string,
    content: string,
    timestamp: number,
    attachments: NormalizedAttachment[],
    attachmentsHash: string,
    assetIds: string[],
    sessionKey: string,
  ) => { event: ServerMessage; sequence: number };
  let insertEventTx!: (
    event: ServerMessage,
    userId: string,
    originatingDeviceId?: string,
    preserveOpaqueSessionKey?: unknown,
  ) => number;
  let deleteStreamDataTx!: (params: { userId: string; sessionKey: string }) => string[];
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
    adopted: row.adopted === 1,
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

  const readAdoptedSessionKeysForUser = (userId: string): string[] => {
    if (!selectAdoptedSessionKeysByUserStmt) {
      return [];
    }
    const rows = selectAdoptedSessionKeysByUserStmt.all(userId) as AdoptedSessionRow[];
    return dedupeKeys(
      rows
        .map((row) => row.sessionKey.trim().toLowerCase())
        .filter((sessionKey) => sessionKey.length > 0),
    );
  };

  const readStreamReadStateMapForUser = (userId: string, sessionKeys?: Set<string>) => {
    if (!selectStreamReadStatesByUserStmt) {
      return {} as Record<string, string>;
    }
    const rows = selectStreamReadStatesByUserStmt.all(userId) as StreamReadStateRow[];
    const result: Record<string, string> = {};
    for (const row of rows) {
      if (sessionKeys && !sessionKeys.has(row.sessionKey)) {
        continue;
      }
      if (typeof row.lastReadMessageId !== "string" || row.lastReadMessageId.length === 0) {
        continue;
      }
      result[row.sessionKey] = row.lastReadMessageId;
    }
    return result;
  };

  const updateStreamReadState = ({
    userId,
    sessionKey,
    lastReadMessageId,
  }: {
    userId: string;
    sessionKey: string;
    lastReadMessageId: string;
  }) => {
    const requestedSessionKey = normalizeSessionKey(sessionKey);
    if (!requestedSessionKey) {
      throw new ClientMessageError("invalid_session", "Invalid sessionKey");
    }
    const existingStream = selectStreamSessionByKeyStmt.get(userId, requestedSessionKey) as
      | StreamSessionRow
      | undefined;
    if (!existingStream) {
      throw new ClientMessageError("invalid_session", "Unknown sessionKey");
    }
    const storedSessionKey = existingStream.sessionKey;
    const eventRow = selectEventByIdStmt.get(lastReadMessageId) as
      | { userId: string; sessionKey: string | null; sequence: number }
      | undefined;
    if (
      !eventRow ||
      eventRow.userId !== userId ||
      !sessionKeyEq(eventRow.sessionKey ?? "", storedSessionKey)
    ) {
      throw new ClientMessageError("invalid_message", "Unknown lastReadMessageId");
    }
    const existing = selectStreamReadStateBySessionStmt.get(userId, storedSessionKey) as
      | StreamReadStateRow
      | undefined;
    if (existing && existing.lastReadSequence >= eventRow.sequence) {
      return {
        updated: false,
        sessionKey: storedSessionKey,
        lastReadMessageId: existing.lastReadMessageId,
      };
    }
    upsertStreamReadStateStmt.run(
      userId,
      storedSessionKey,
      lastReadMessageId,
      eventRow.sequence,
      nowMs(),
    );
    return {
      updated: true,
      sessionKey: storedSessionKey,
      lastReadMessageId,
    };
  };

  const readStreamReadStatesForUser = (
    userId: string,
    allowedSessionKeys?: string[],
  ): Record<string, string> => {
    const allowed = allowedSessionKeys
      ? new Set(allowedSessionKeys.map((sessionKey) => normalizeSessionKey(sessionKey)))
      : null;
    return readStreamReadStateMapForUser(userId, allowed ?? undefined);
  };

  const readStreamTailStatesForUser = (
    userId: string,
    allowedSessionKeys?: string[],
  ): Record<string, StreamTailState> => {
    if (!selectStreamTailStatesByUserStmt) {
      return {};
    }
    const allowed = allowedSessionKeys
      ? new Set(allowedSessionKeys.map((sessionKey) => normalizeSessionKey(sessionKey)))
      : null;
    const rows = selectStreamTailStatesByUserStmt.all(userId, userId) as StreamTailStateRow[];
    const states: Record<string, StreamTailState> = {};
    for (const row of rows) {
      const normalizedSessionKey = normalizeSessionKey(row.sessionKey);
      if (!normalizedSessionKey) {
        continue;
      }
      if (allowed && !allowed.has(normalizedSessionKey)) {
        continue;
      }
      const parsed = parseServerMessage(row.payloadJson, logger);
      if (
        !parsed ||
        parsed.type !== "message" ||
        !SERVER_EVENT_ID_REGEX.test(parsed.id) ||
        (parsed.role !== "user" && parsed.role !== "assistant")
      ) {
        continue;
      }
      states[row.sessionKey] = {
        lastMessageId: parsed.id,
        lastMessageRole: parsed.role,
      };
    }
    return states;
  };

  const filterStreamAccess = (streams: StreamSession[], isAdmin: boolean): StreamSession[] => {
    if (isAdmin) {
      return streams;
    }
    return streams.filter((stream) => !sessionKeyEq(stream.sessionKey, mainSessionKey));
  };

  const resolveFallbackStreamKeysForSession = (session: Session): string[] => {
    const fallbackKeys = [session.personalSessionKey];
    if (session.dmScope !== "main") {
      fallbackKeys.push(session.dmSessionKey);
    }
    if (session.isAdmin) {
      fallbackKeys.push(session.globalSessionKey);
    }
    return fallbackKeys;
  };

  const applyStreamSubscriptionsToSession = (
    session: Session,
    streams: StreamSession[],
    adoptedSessionKeys: string[] = session.adoptedSessionKeys,
  ) => {
    const visible = filterStreamAccess(streams, session.isAdmin);
    const streamSessionKeys = dedupeKeys(
      visible.length > 0
        ? visible.map((stream) => stream.sessionKey)
        : resolveFallbackStreamKeysForSession(session),
    );
    session.adoptedSessionKeys = dedupeKeys(adoptedSessionKeys);
    const keys = dedupeKeys([...streamSessionKeys, ...session.adoptedSessionKeys]);
    session.provisionedSessionKeys = keys;
    session.sessionKeys = keys;
    if (!keys.some((key) => sessionKeyEq(key, session.sessionKey))) {
      const preferred = keys.find((key) => sessionKeyEq(key, session.personalSessionKey));
      session.sessionKey = preferred ?? keys[0] ?? session.personalSessionKey;
    }
  };

  const syncUserSessionSubscriptions = (
    userId: string,
    streams?: StreamSession[],
    adoptedSessionKeys?: string[],
  ) => {
    const resolvedStreams = streams ?? readStreamSessionsForUser(userId);
    const resolvedAdoptedSessionKeys = adoptedSessionKeys ?? readAdoptedSessionKeysForUser(userId);
    const sessions = userSessions.get(userId);
    if (!sessions) {
      return;
    }
    for (const session of sessions) {
      const mergedAdoptedSessionKeys = dedupeKeys([
        ...resolvedAdoptedSessionKeys,
        ...session.adoptedSessionKeys,
      ]);
      applyStreamSubscriptionsToSession(session, resolvedStreams, mergedAdoptedSessionKeys);
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
        0,
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
          adopted: false,
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
          adopted: false,
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
          adopted: false,
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
          0,
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

  function migrateDatabase(database: SqliteDatabase) {
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
        adopted INTEGER NOT NULL DEFAULT 0,
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
      CREATE TABLE IF NOT EXISTS adopted_sessions (
        userId TEXT NOT NULL,
        sessionKey TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        PRIMARY KEY (userId, sessionKey)
      );
      CREATE INDEX IF NOT EXISTS idx_adopted_sessions_user_created
        ON adopted_sessions(userId, createdAt);
      CREATE TABLE IF NOT EXISTS stream_read_state (
        userId TEXT NOT NULL,
        sessionKey TEXT NOT NULL,
        lastReadMessageId TEXT NOT NULL,
        lastReadSequence INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (userId, sessionKey)
      );
      CREATE INDEX IF NOT EXISTS idx_stream_read_state_user_updated
        ON stream_read_state(userId, updatedAt);
    `);
    if (!tableHasColumn("stream_sessions", "adopted")) {
      database.exec(`ALTER TABLE stream_sessions ADD COLUMN adopted INTEGER NOT NULL DEFAULT 0`);
    }
    database.exec(
      `UPDATE stream_sessions SET adopted = 1 WHERE sessionKey NOT LIKE '%:clawline:%'`,
    );

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
         (userId, sessionKey, displayName, kind, orderIndex, isBuiltIn, adopted, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            0,
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
      if (currentVersion < 2) {
        const discovered = historicalByUser.get(userId) ?? new Set<string>();
        insertCustomStreamsForUser(userId, discovered);
      }
    }

    if (currentVersion < 2) {
      const selectEventsForBackfill = database.prepare(
        `SELECT id, userId, payloadJson, sessionKey
         FROM events
         WHERE eventType = 'message'`,
      );
      const updateEventSessionKey = database.prepare(
        `UPDATE events SET sessionKey = ? WHERE id = ?`,
      );
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
                resolvedSessionKey = normalizeStoredSessionKey(
                  payload.sessionKey,
                  normalizedUserId,
                );
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
    }

    if (currentVersion < 4) {
      database.exec(
        `UPDATE stream_sessions
         SET adopted = 1
         WHERE sessionKey NOT LIKE '%:clawline:%'`,
      );
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

    migrateDatabase(newDb);

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
    updateActiveMessagesStreamingByDeviceStmt = newDb.prepare(
      `UPDATE messages
       SET streaming = ?
       WHERE deviceId = ? AND streaming IN (${MessageStreamingState.Active}, ${MessageStreamingState.Queued})`,
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
      `SELECT userId, sessionKey, displayName, kind, orderIndex, isBuiltIn, adopted, createdAt, updatedAt
       FROM stream_sessions
       WHERE userId = ?
       ORDER BY orderIndex ASC`,
    );
    selectStreamSessionByKeyStmt = newDb.prepare(
      `SELECT userId, sessionKey, displayName, kind, orderIndex, isBuiltIn, adopted, createdAt, updatedAt
       FROM stream_sessions
       WHERE userId = ? AND sessionKey = ?`,
    );
    selectStreamMaxOrderStmt = newDb.prepare(
      `SELECT MAX(orderIndex) as maxOrder FROM stream_sessions WHERE userId = ?`,
    );
    insertStreamSessionStmt = newDb.prepare(
      `INSERT INTO stream_sessions
         (userId, sessionKey, displayName, kind, orderIndex, isBuiltIn, adopted, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    selectStreamReadStatesByUserStmt = newDb.prepare(
      `SELECT userId, sessionKey, lastReadMessageId, lastReadSequence, updatedAt
       FROM stream_read_state
       WHERE userId = ?`,
    );
    selectStreamReadStateBySessionStmt = newDb.prepare(
      `SELECT userId, sessionKey, lastReadMessageId, lastReadSequence, updatedAt
       FROM stream_read_state
       WHERE userId = ? AND sessionKey = ?`,
    );
    upsertStreamReadStateStmt = newDb.prepare(
      `INSERT INTO stream_read_state
         (userId, sessionKey, lastReadMessageId, lastReadSequence, updatedAt)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(userId, sessionKey) DO UPDATE SET
         lastReadMessageId = excluded.lastReadMessageId,
         lastReadSequence = excluded.lastReadSequence,
         updatedAt = excluded.updatedAt`,
    );
    deleteStreamReadStateBySessionStmt = newDb.prepare(
      `DELETE FROM stream_read_state WHERE userId = ? AND sessionKey = ?`,
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
    selectAdoptedSessionKeysByUserStmt = newDb.prepare(
      `SELECT userId, sessionKey, createdAt
       FROM adopted_sessions
       WHERE userId = ?
       ORDER BY createdAt ASC, sessionKey ASC`,
    );
    insertAdoptedSessionStmt = newDb.prepare(
      `INSERT OR IGNORE INTO adopted_sessions (userId, sessionKey, createdAt)
       VALUES (?, ?, ?)`,
    );
    selectStreamTailStatesByUserStmt = newDb.prepare(
      `SELECT latest.sessionKey, events.payloadJson
       FROM (
         SELECT sessionKey, MAX(sequence) as maxSequence
         FROM events
         WHERE userId = ? AND eventType = 'message' AND sessionKey IS NOT NULL
         GROUP BY sessionKey
       ) AS latest
       JOIN events
         ON events.userId = ?
        AND events.sessionKey = latest.sessionKey
        AND events.sequence = latest.maxSequence`,
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
          clientMessageId: messageId,
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

    selectEventsTailStmt = newDb.prepare(
      `SELECT id, payloadJson
       FROM events
       WHERE userId = ? AND eventType = 'message'
       ORDER BY sequence DESC LIMIT ?`,
    );
    selectEventsTailBySessionStmt = newDb.prepare(
      `SELECT id, payloadJson, sequence, timestamp
       FROM events
       WHERE userId = ? AND eventType = 'message' AND sessionKey = ?
       ORDER BY sequence DESC LIMIT ?`,
    );
    selectEventsAfterBySessionStmt = newDb.prepare(
      `SELECT id, payloadJson, sequence, timestamp
       FROM events
       WHERE userId = ? AND eventType = 'message' AND sessionKey = ? AND sequence > ?
       ORDER BY sequence DESC LIMIT ?`,
    );
    selectEventByIdStmt = newDb.prepare(
      `SELECT id, userId, sessionKey, sequence, timestamp
       FROM events
       WHERE id = ? AND eventType = 'message'`,
    );
    selectEventPayloadForUserStmt = newDb.prepare(
      `SELECT payloadJson FROM events WHERE userId = ? AND id = ? AND eventType = 'message'`,
    );
    insertEventTx = newDb.transaction(
      (
        event: ServerMessage,
        userId: string,
        originatingDeviceId?: string,
        preserveOpaqueSessionKey = false,
      ) => {
        const payloadJson = JSON.stringify(event);
        const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
        const sequenceRow = sequenceStatement.get(userId) as { sequence: number };
        const normalizedSessionKey =
          typeof event.sessionKey === "string"
            ? preserveOpaqueSessionKey
              ? normalizeSessionKey(event.sessionKey)
              : normalizeStoredSessionKey(event.sessionKey, userId)
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
      deleteStreamReadStateBySessionStmt.run(params.userId, params.sessionKey);
      deleteMessageAssetsBySessionStmt.run(params.userId, params.userId, params.sessionKey);
      deleteMessagesBySessionStmt.run(params.userId, params.userId, params.sessionKey);
      deleteEventsBySessionStmt.run(params.userId, params.sessionKey);
      deleteStreamSessionStmt.run(params.userId, params.sessionKey);
      deleteStreamReadStateBySessionStmt.run(params.userId, params.sessionKey);
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
      if (isInlineImage && buffer.length <= config.media.maxInlineBytes) {
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
      if (isInlineImage && buffer.length <= config.media.maxInlineBytes) {
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

  async function loadInboundAssetImage(assetId: string): Promise<{
    data: string;
    mimeType: string;
  } | null> {
    const asset = selectAssetStmt.get(assetId) as { mimeType: string } | undefined;
    if (!asset) {
      logger.warn?.("[clawline] inbound_asset_row_missing", { assetId });
      return null;
    }
    const mimeType = typeof asset?.mimeType === "string" ? asset.mimeType.trim().toLowerCase() : "";
    if (!mimeType.startsWith("image/")) {
      return null;
    }
    const assetPath = path.join(assetsDir, assetId);
    try {
      const buffer = await fs.readFile(assetPath);
      if (buffer.length === 0) {
        return null;
      }
      return {
        mimeType,
        data: buffer.toString("base64"),
      };
    } catch (err) {
      logger.warn?.(`[clawline] asset_image_read_failed: ${formatError(err)}`, { assetId });
      return null;
    }
  }

  type EventRow = { id: string; payloadJson: string; sequence?: number; timestamp?: number };

  const logHttpRequest = (event: string, info?: Record<string, unknown>) => {
    if (info) {
      logger.info?.(`[clawline:http] ${event}`, info);
    } else {
      logger.info?.(`[clawline:http] ${event}`);
    }
  };

  const requestHandler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
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
      if (isStreamApiPath(parsedUrl.pathname)) {
        const originCheck = checkClawlineBrowserOrigin({
          originHeader: req.headers.origin,
          allowedOrigins: config.network.allowedOrigins,
        });
        logger.info?.("[clawline:http] stream_api_origin_check", {
          origin: originCheck.origin,
          allowed: config.network.allowedOrigins,
          originAllowed: originCheck.ok,
          matchedBy: originCheck.ok ? originCheck.matchedBy : null,
          path: parsedUrl.pathname,
          reason: originCheck.ok ? null : originCheck.reason,
        });
        if (!originCheck.ok) {
          logger.warn?.("[clawline:http] stream_api_origin_rejected", {
            origin: originCheck.origin,
            path: parsedUrl.pathname,
            reason: originCheck.reason,
            setting: CLAWLINE_ALLOWED_ORIGINS_SETTING,
          });
          sendStreamApiError(res, 403, "origin_not_allowed", originCheck.reason);
          return;
        }
        applyStreamApiCorsHeaders(res, originCheck.origin);
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          logHttpRequest("request_handled", {
            method: req.method,
            path: parsedUrl.pathname,
            status: 204,
          });
          return;
        }
      }
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
      if (req.method === "GET" && parsedUrl.pathname === "/api/trackable-sessions") {
        await handleListTrackableSessionsRequest(req, res);
        return;
      }
      if (req.method === "GET" && parsedUrl.pathname === "/api/session-status") {
        await handleSessionStatusRequest(req, res);
        return;
      }
      if (req.method === "POST" && parsedUrl.pathname === "/api/session-control") {
        await handleSessionControlRequest(req, res);
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
      if (req.method === "POST" && parsedUrl.pathname === "/api/streams/adopt") {
        await handleAdoptSessionRequest(req, res);
        return;
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
      const isStreamApi = isStreamApiPath(pathName);
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
  };

  const httpServer =
    providerTls.enabled && providerTls.tlsOptions
      ? https.createServer(providerTls.tlsOptions, requestHandler)
      : http.createServer(requestHandler);

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
      const alertResolvedKey = await resolveValidatedAlertSessionKey(payload.sessionKey);
      logger.info?.("[clawline] alert_received", {
        source: payload.source,
        hasSessionKey: Boolean(payload.sessionKey),
      });
      logger.info?.("[clawline] alert_payload_received", {
        bytes: Buffer.byteLength(payload.raw, "utf8"),
        sessionKey: payload.sessionKey ?? "undefined",
      });
      let text = buildAlertText(payload.message, payload.source);
      const pendingEvents = peekSystemEvents(alertResolvedKey);
      const hasExecCompletion = pendingEvents.some((event) => event.includes("Exec finished"));
      if (hasExecCompletion) {
        text = `${EXEC_COMPLETION_ALERT_PROMPT}\n\n${text}`;
      }
      // Apply alert instructions last so they stay at the end and include the exec prompt in size checks.
      if (payload.noOverlay !== true) {
        text = await applyAlertInstructions(text);
      }
      text = applyMainSessionAlertRequirement(text, alertResolvedKey);
      await wakeGatewayForAlert(text, alertResolvedKey, payload.attachments);
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

  async function parseAlertPayload(req: http.IncomingMessage): Promise<{
    attachments?: unknown[];
    raw: string;
    message: string;
    source?: string;
    sessionKey?: string;
    noOverlay?: boolean;
  }> {
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
    const noOverlay = typeof obj.noOverlay === "boolean" ? obj.noOverlay : undefined;
    const attachments =
      obj.attachments === undefined
        ? undefined
        : Array.isArray(obj.attachments)
          ? obj.attachments
          : null;
    if (!message.trim()) {
      throw new HttpError(400, "invalid_message", "Alert message is required");
    }
    if (attachments === null) {
      throw new HttpError(400, "invalid_request", "Alert attachments must be an array");
    }
    return { attachments, raw: rawText, message, source, sessionKey, noOverlay };
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
    resolveAlertSource(source);
    if (Buffer.byteLength(normalizedMessage, "utf8") > config.sessions.maxMessageBytes) {
      throw new HttpError(400, "message_too_large", "Alert message exceeds max size");
    }
    return normalizedMessage;
  }

  function normalizeAlertMessage(value: string): string | null {
    const cleaned = stripControlChars(value).trim();
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

  function applyMainSessionAlertRequirement(text: string, sessionKey: string): string {
    if (!sessionKeyEq(sessionKey, mainSessionKey)) {
      return text;
    }
    const combined = `${text}\n\n${MAIN_SESSION_ALERT_REPLY_TEXT}`;
    if (Buffer.byteLength(combined, "utf8") > config.sessions.maxMessageBytes) {
      logger.warn?.("main_session_alert_requirement_skipped", {
        reason: "message_too_large",
        textBytes: Buffer.byteLength(text, "utf8"),
        requirementBytes: Buffer.byteLength(MAIN_SESSION_ALERT_REPLY_TEXT, "utf8"),
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

  function resolveAlertSessionKey(rawSessionKey?: string): string {
    return rawSessionKey?.trim() || mainSessionKey;
  }

  function logAlertRunPhase(
    phase:
      | "queued"
      | "wake-dispatched"
      | "agent-run-start"
      | "agent-run-end"
      | "replied"
      | "no-reply",
    details: {
      sessionKey: string;
      runId: string;
      payloadCount?: number;
      status?: string;
      error?: string;
    },
  ) {
    const suffix = [
      `phase=${phase}`,
      `sessionKey=${details.sessionKey}`,
      `runId=${details.runId}`,
      ...(typeof details.payloadCount === "number" ? [`payloadCount=${details.payloadCount}`] : []),
      ...(details.status ? [`status=${details.status}`] : []),
      ...(details.error ? [`error=${details.error}`] : []),
    ].join(" ");
    logger.info?.(`[clawline] alert_run_phase ${suffix}`);
  }

  function countAlertReplyPayloads(result: unknown): number {
    if (!result || typeof result !== "object") {
      return 0;
    }
    const payloads = (
      result as {
        result?: {
          payloads?: unknown;
        };
      }
    ).result?.payloads;
    return Array.isArray(payloads) ? payloads.length : 0;
  }

  async function resolveValidatedAlertSessionKey(rawSessionKey?: string): Promise<string> {
    const resolvedSessionKey = resolveAlertSessionKey(rawSessionKey);
    const parsedAgentSessionKey = parseAgentSessionKey(resolvedSessionKey);
    if (!parsedAgentSessionKey) {
      throw new HttpError(400, "invalid_session_key", "Invalid session key");
    }
    const streamSessionKey = await resolveExistingClawlineAlertStreamSessionKey(resolvedSessionKey);
    if (streamSessionKey) {
      return streamSessionKey;
    }
    const fallbackSessionKey = await resolveAlertFallbackSessionKey(resolvedSessionKey);
    if (!fallbackSessionKey) {
      throw new HttpError(404, "stream_not_found", "Stream not found");
    }
    return fallbackSessionKey;
  }

  async function resolveExistingClawlineAlertStreamSessionKey(
    resolvedSessionKey: string,
  ): Promise<string | null> {
    const parsed = parseClawlineUserSessionKey(resolvedSessionKey);
    const candidateEntries = allowlist.entries.filter((entry) => {
      if (sessionKeyEq(resolvedSessionKey, mainSessionKey)) {
        return entry.isAdmin;
      }
      return parsed?.userId === sanitizeUserId(entry.userId).toLowerCase();
    });
    for (const entry of candidateEntries) {
      const found = await runPerUserTask(entry.userId, async () =>
        enqueueWriteTask(() => {
          const normalizedSessionKey = normalizeStreamMutationSessionKeyForUser(
            entry.userId,
            resolvedSessionKey,
          );
          if (!normalizedSessionKey) {
            return null;
          }
          const streams = ensureStreamSessionsForUser({
            userId: entry.userId,
            isAdmin: entry.isAdmin,
          });
          return (
            streams.find((stream) => sessionKeyEq(stream.sessionKey, normalizedSessionKey))
              ?.sessionKey ?? null
          );
        }),
      );
      if (found) {
        return found;
      }
    }
    return null;
  }

  async function wakeGatewayForAlert(text: string, sessionKey?: string, attachments?: unknown[]) {
    try {
      const resolvedSessionKey = resolveAlertSessionKey(sessionKey);
      const gatewayToken =
        (typeof openClawCfg.gateway?.auth?.token === "string"
          ? openClawCfg.gateway.auth.token
          : undefined) ||
        (typeof (openClawCfg.gateway as { token?: unknown } | undefined)?.token === "string"
          ? (openClawCfg.gateway as { token?: string }).token
          : undefined);

      logger.info?.(`[clawline] alert_wake_start sessionKey=${resolvedSessionKey}`);

      const queueSettings = resolveClawlineQueueSettings({ cfg: openClawCfg });
      const alertRunId = randomUUID();
      const sendQueuedAlert = async (item: ClawlineAnnounceQueueItem) => {
        const correlatedRunId = item.announceId?.trim() || alertRunId;
        const phaseBase = {
          sessionKey: item.sessionKey,
          runId: correlatedRunId,
        };
        const origin = item.origin;
        const threadId =
          origin?.threadId != null && origin.threadId !== "" ? String(origin.threadId) : undefined;
        logAlertRunPhase("wake-dispatched", phaseBase);
        logAlertRunPhase("agent-run-start", phaseBase);
        try {
          const result = await callClawlineGatewayAgent({
            token: gatewayToken,
            request: {
              sessionKey: item.sessionKey,
              message: item.prompt,
              channel: origin?.channel,
              accountId: origin?.accountId,
              to: origin?.to,
              threadId,
              deliver: true,
              attachments: item.attachments,
              idempotencyKey: correlatedRunId,
            },
            timeoutMs: 300_000,
          });
          const payloadCount = countAlertReplyPayloads(result);
          logAlertRunPhase("agent-run-end", {
            ...phaseBase,
            status: "ok",
            payloadCount,
          });
          logAlertRunPhase(payloadCount > 0 ? "replied" : "no-reply", {
            ...phaseBase,
            payloadCount,
          });
        } catch (err) {
          logAlertRunPhase("agent-run-end", {
            ...phaseBase,
            status: "error",
            error: formatError(err),
          });
          throw err;
        }
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
          announceId: alertRunId,
          attachments,
          prompt: text,
          summaryLine: "System Alert",
          enqueuedAt: Date.now(),
          sessionKey: resolvedSessionKey,
          origin: alertOrigin,
        } as ClawlineAnnounceQueueItem,
        settings: queueSettings,
        send: sendQueuedAlert,
      });

      logger.info?.(`[clawline] alert_wake_result outcome=queued sessionKey=${resolvedSessionKey}`);
      logAlertRunPhase("queued", {
        sessionKey: resolvedSessionKey,
        runId: alertRunId,
      });
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
    const originHeader = Array.isArray(request.headers.origin)
      ? request.headers.origin[0]
      : request.headers.origin;
    const origin = originHeader ?? null;
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
    const originCheck = checkClawlineBrowserOrigin({
      originHeader,
      allowedOrigins: config.network.allowedOrigins,
    });
    logger.info?.("[clawline:http] ws_upgrade_origin_check", {
      origin,
      allowed: config.network.allowedOrigins,
      originAllowed: originCheck.ok,
      matchedBy: originCheck.ok ? originCheck.matchedBy : null,
      reason: originCheck.ok ? null : originCheck.reason,
    });
    if (!originCheck.ok) {
      logger.warn?.("[clawline:http] ws_upgrade_origin_rejected", {
        origin: originCheck.origin,
        reason: originCheck.reason,
        setting: CLAWLINE_ALLOWED_ORIGINS_SETTING,
      });
      socket.end(buildRejectedOriginUpgradeResponse(originCheck.reason));
      return;
    }
    logger.info?.("[clawline:http] ws_upgrade_forward", { origin });
    server.handleUpgrade(request, socket, head, (ws) => {
      logger.info?.("[clawline:http] ws_handle_upgrade_complete", { origin });
      server.emit("connection", ws, request);
    });
  });

  const connectionState = new WeakMap<WebSocket, ConnectionState>();
  type TerminalConnectionState =
    | { authenticated: false; authInProgress?: boolean }
    | {
        authenticated: true;
        deviceId: string;
        userId: string;
        terminalSessionId: string;
        tmuxSessionName: string;
        paneId: string;
        tmuxBackend: TerminalTmuxBackend;
        pty: PtyProcess;
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
  let assetCleanupInterval: ReturnType<typeof setInterval> | null = null;
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
          throw new Error(
            "Clawline terminal session descriptor is invalid (expected base64 JSON with terminalSessionId).",
          );
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
          destination: descriptor.destination,
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
  }): { sessionKey: string; title?: string; destination?: TerminalDestination } | null {
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
        return {
          sessionKey,
          title: descriptor.title || undefined,
          destination: descriptor.destination,
        };
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
        updateActiveMessagesStreamingByDeviceStmt?.run(
          MessageStreamingState.Failed,
          revoked.deviceId,
        );
        if (session) {
          session.revoked = true;
          session.replayInProgress = false;
          session.resolveReplayBarrier();
          removeSession(session);
          connectionState.delete(session.socket);
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
    logger.info?.(
      `[clawline:http] pending_approval_delivered ${describePairingEntry(entry)} userId=${entry.userId} isAdmin=${entry.isAdmin} delivered=${delivered}`,
    );
    pending.socket.close();
    await removePendingEntry(entry.deviceId).catch(() => {});
  }

  function isDenylisted(deviceId: string) {
    return denylist.some((entry) => entry.deviceId === deviceId);
  }

  function markMessageFailedIfDeviceRevoked(deviceId: string, clientId: string): boolean {
    if (!isDenylisted(deviceId)) {
      return false;
    }
    updateMessageStreamingStmt.run(MessageStreamingState.Failed, deviceId, clientId);
    return true;
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

  function socketStateLabel(ws: WebSocket): string {
    switch (ws.readyState) {
      case WebSocket.CONNECTING:
        return "connecting";
      case WebSocket.OPEN:
        return "open";
      case WebSocket.CLOSING:
        return "closing";
      case WebSocket.CLOSED:
        return "closed";
      default:
        return `unknown:${String(ws.readyState)}`;
    }
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

  function sendSessionControlJson(res: http.ServerResponse, status: number, payload: unknown) {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(status);
    res.end(JSON.stringify(payload));
  }

  type SessionControlModelCatalogStatus =
    | {
        available: true;
        models: Array<{
          id: string;
          provider: string;
          name: string;
          alias?: string;
        }>;
      }
    | {
        available: false;
        reason: string;
        models: [];
      };

  function sessionControlCapabilities() {
    const supported = {
      supported: true,
    };
    return {
      cancelCurrentRun: {
        supported: false,
        reason: "provider_abort_seam_not_available",
      },
      setModel: {
        supported: true,
      },
      setThinking: supported,
      setReasoning: supported,
      setFastMode: supported,
      setMode: supported,
      setVerbosity: supported,
      readOnlyStatus: false,
    };
  }

  function mutableSessionControlCapabilities() {
    return sessionControlCapabilities();
  }

  function adoptedSessionControlCapabilities() {
    const unsupported = {
      supported: false,
      reason: "adopted_session_read_only",
    };
    return {
      cancelCurrentRun: unsupported,
      setModel: unsupported,
      setThinking: unsupported,
      setReasoning: unsupported,
      setFastMode: unsupported,
      setMode: unsupported,
      setVerbosity: unsupported,
      readOnlyStatus: true,
    };
  }

  function sessionControlCapabilitiesForSession(userId: string, sessionKey: string) {
    const row = loadStreamRowForUser(userId, normalizeSessionKey(sessionKey));
    if (row?.adopted === 1) {
      return adoptedSessionControlCapabilities();
    }
    return mutableSessionControlCapabilities();
  }

  async function loadSessionControlModelCatalog(
    sessionKey: string,
  ): Promise<SessionControlModelCatalogStatus> {
    try {
      const catalog = await loadModelCatalog({ config: openClawCfg });
      const agentId = resolveAgentIdFromSessionKey(sessionKey);
      const defaultModel = resolveDefaultModelForAgent({ cfg: openClawCfg, agentId });
      const allowed = buildAllowedModelSet({
        cfg: openClawCfg,
        catalog,
        defaultProvider: defaultModel.provider,
        defaultModel: defaultModel.model,
        agentId,
      });
      const models = allowed.allowedCatalog.map((entry) => {
        const model: SessionControlModelCatalogStatus["models"][number] = {
          id: entry.id,
          provider: entry.provider,
          name: entry.name,
        };
        if (entry.alias) {
          model.alias = entry.alias;
        }
        return model;
      });
      return { available: true, models };
    } catch (err) {
      logger.warn?.(
        `[clawline:session-control] failed to load model catalog for ${sessionKey}: ${String(err)}`,
      );
      return {
        available: false,
        reason: "model_catalog_unavailable",
        models: [],
      };
    }
  }

  function assertSessionControlSessionAccess(userId: string, sessionKey: string) {
    const normalizedSessionKey = normalizeStreamMutationSessionKeyForUser(userId, sessionKey);
    if (normalizedSessionKey) {
      return normalizedSessionKey;
    }
    const opaqueSessionKey = normalizeSessionKey(sessionKey);
    const adopted = loadStreamRowForUser(userId, opaqueSessionKey);
    if (adopted?.adopted === 1) {
      return opaqueSessionKey;
    }
    throw new HttpError(404, "stream_not_found", "Stream not found");
  }

  function resolveSessionControlSessionKey(req: http.IncomingMessage, userId: string) {
    const parsedUrl = new URL(req.url ?? "/", "http://localhost");
    const rawSessionKey = parsedUrl.searchParams.get("sessionKey")?.trim() ?? "";
    if (!rawSessionKey) {
      throw new HttpError(400, "invalid_session_key", "sessionKey is required");
    }
    return assertSessionControlSessionAccess(userId, rawSessionKey);
  }

  function normalizeStatusString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }

  function resolveStatusModel(
    entry: SessionEntry | undefined,
    snapshot: SessionStatusRuntimeSnapshot | null,
  ) {
    const provider =
      normalizeStatusString(entry?.providerOverride) ??
      normalizeStatusString(entry?.modelProvider) ??
      snapshot?.provider ??
      null;
    const model =
      normalizeStatusString(entry?.modelOverride) ??
      normalizeStatusString(entry?.model) ??
      snapshot?.model ??
      null;
    return { provider, model };
  }

  function resolveStatusFastMode(
    entry: SessionEntry | undefined,
    snapshot: SessionStatusRuntimeSnapshot | null,
  ) {
    if (typeof entry?.fastMode === "boolean") {
      return entry.fastMode;
    }
    return snapshot?.fastMode ?? null;
  }

  function rememberSessionRuntimeStatus(
    sessionKey: string,
    snapshot: SessionStatusRuntimeSnapshot,
  ) {
    sessionRuntimeStatusSnapshots.set(normalizeSessionKey(sessionKey), snapshot);
  }

  async function buildSessionStatusPayload(userId: string, sessionKey: string) {
    const normalizedSessionKey = normalizeSessionKey(sessionKey);
    const activeRun = activeSessionRuns.get(normalizedSessionKey) ?? null;
    const snapshot = sessionRuntimeStatusSnapshots.get(normalizedSessionKey) ?? null;
    const { entry } = loadSessionStoreEntryForKey(sessionKey);
    const queueDepth = getClawlineFollowupQueueDepth(sessionKey);
    const modelStatus = resolveStatusModel(entry, activeRun ?? snapshot);
    const thinkingLevel =
      normalizeStatusString(entry?.thinkingLevel) ??
      activeRun?.thinkingLevel ??
      snapshot?.thinkingLevel ??
      null;
    const fastMode = resolveStatusFastMode(entry, activeRun ?? snapshot);
    const modelCatalog = await loadSessionControlModelCatalog(sessionKey);
    return {
      sessionKey,
      display: {
        model: modelStatus.model,
        fallbackModels: null,
        provider: modelStatus.provider,
        harness: null,
        reasoningLevel: normalizeStatusString(entry?.reasoningLevel),
        thinkingLevel,
        fastMode,
        mode: fastMode == null ? null : fastMode ? "fast" : "normal",
        verbosity: normalizeStatusString(entry?.verboseLevel),
      },
      run: activeRun
        ? {
            state: "running",
            runId: activeRun.runId,
            messageId: activeRun.messageId,
            startedAt: activeRun.startedAt,
            queueDepth,
          }
        : {
            state: queueDepth > 0 ? "queued" : "idle",
            runId: null,
            messageId: null,
            startedAt: null,
            queueDepth,
          },
      context: {
        available: false,
        compaction: null,
      },
      approval: {
        state: null,
      },
      capabilities: sessionControlCapabilitiesForSession(userId, sessionKey),
      modelCatalog,
    };
  }

  async function handleSessionStatusRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const auth = authenticateHttpRequest(req);
    const sessionKey = resolveSessionControlSessionKey(req, auth.userId);
    sendSessionControlJson(res, 200, await buildSessionStatusPayload(auth.userId, sessionKey));
  }

  function rejectUnsupportedSessionControl(
    res: http.ServerResponse,
    sessionKey: string,
    action: string,
    code: string,
    message: string,
    capabilities: unknown,
  ) {
    sendSessionControlJson(res, 200, {
      ok: false,
      sessionKey,
      action,
      code,
      message,
      capabilities,
    });
  }

  function controlString(body: ClientPayload, key: string): string | null | undefined {
    if (!(key in body)) {
      return undefined;
    }
    const value = body[key];
    if (value === null) {
      return null;
    }
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  }

  function pickControlString(
    body: ClientPayload,
    keys: readonly string[],
  ): string | null | undefined {
    for (const key of keys) {
      if (key in body) {
        return controlString(body, key);
      }
    }
    return undefined;
  }

  function controlBoolean(body: ClientPayload, key: string): boolean | null | undefined {
    if (!(key in body)) {
      return undefined;
    }
    const value = body[key];
    if (value === null) {
      return null;
    }
    if (typeof value === "boolean") {
      return value;
    }
    return undefined;
  }

  function resolveSessionControlPatch(body: ClientPayload, action: string) {
    switch (action) {
      case "set_model":
        return {
          model: typeof body.model === "string" ? body.model.trim() || undefined : undefined,
        };
      case "set_thinking":
        return { thinkingLevel: controlString(body, "thinkingLevel") };
      case "set_reasoning":
        return {
          reasoningLevel: pickControlString(body, ["reasoningLevel", "level"]),
        };
      case "set_fast_mode": {
        const fastMode = controlBoolean(body, "fastMode");
        if (fastMode !== undefined) {
          return { fastMode };
        }
        const enabled = controlBoolean(body, "enabled");
        return { fastMode: enabled };
      }
      case "set_mode": {
        const mode = controlString(body, "mode")?.toLowerCase();
        if (mode === "fast") {
          return { fastMode: true };
        }
        if (mode === "normal") {
          return { fastMode: false };
        }
        return { fastMode: undefined };
      }
      case "set_verbosity":
        return {
          verboseLevel: pickControlString(body, ["verbosity", "verboseLevel"]),
        };
      default:
        return null;
    }
  }

  async function applySessionControlPatch(sessionKey: string, patch: Record<string, unknown>) {
    let result:
      | Awaited<ReturnType<typeof applySessionsPatchToStore>>
      | { ok: false; error: { code: string; message: string } } = {
      ok: false,
      error: { code: "invalid_request", message: "No mutation was requested" },
    };
    await updateSessionStore(sessionStorePath, async (store) => {
      const resolved = resolveSessionStoreEntry({ store, sessionKey });
      result = await applySessionsPatchToStore({
        cfg: openClawCfg,
        store,
        storeKey: resolved.normalizedKey,
        patch: {
          key: resolved.normalizedKey,
          ...patch,
        },
        loadGatewayModelCatalog: () => loadModelCatalog({ config: openClawCfg }),
      });
    });
    return result;
  }

  async function handleSessionControlRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const auth = authenticateHttpRequest(req);
    const body = await parseStreamsRequestBody(req);
    const rawSessionKey = typeof body.sessionKey === "string" ? body.sessionKey.trim() : "";
    if (!rawSessionKey) {
      throw new HttpError(400, "invalid_session_key", "sessionKey is required");
    }
    const sessionKey = assertSessionControlSessionAccess(auth.userId, rawSessionKey);
    const action = typeof body.action === "string" ? body.action.trim() : "";
    const supportedActions = new Set([
      "cancel_current_run",
      "set_model",
      "set_thinking",
      "set_reasoning",
      "set_fast_mode",
      "set_mode",
      "set_verbosity",
    ]);
    if (!supportedActions.has(action)) {
      throw new HttpError(400, "invalid_action", "Unsupported session control action");
    }
    const capabilities = sessionControlCapabilitiesForSession(auth.userId, sessionKey);
    if (capabilities.readOnlyStatus) {
      rejectUnsupportedSessionControl(
        res,
        sessionKey,
        action,
        "unsupported",
        "This session is read-only from the provider control plane.",
        capabilities,
      );
      return;
    }
    if (action === "cancel_current_run") {
      rejectUnsupportedSessionControl(
        res,
        sessionKey,
        action,
        "unsupported",
        "The current Clawline provider dispatch path does not expose a per-session abort seam.",
        capabilities,
      );
      return;
    }
    const patch = resolveSessionControlPatch(body, action);
    if (!patch || Object.values(patch).some((value) => value === undefined)) {
      throw new HttpError(400, "invalid_control_payload", "Invalid session control payload");
    }
    const result = await applySessionControlPatch(sessionKey, patch);
    if (!result.ok) {
      sendSessionControlJson(res, 200, {
        ok: false,
        sessionKey,
        action,
        code: result.error.code,
        message: result.error.message,
        capabilities,
      });
      return;
    }
    sendSessionControlJson(res, 200, {
      ok: true,
      sessionKey,
      action,
      status: await buildSessionStatusPayload(auth.userId, sessionKey),
      capabilities,
    });
  }

  function normalizeStreamMutationSessionKeyForUser(userId: string, sessionKey: string): string {
    // Mutation paths must never fall back to a default stream key.
    // If the path key is malformed, return not-found semantics.
    const opaqueNormalized = normalizeSessionKey(sessionKey);
    if (
      opaqueNormalized &&
      selectStreamSessionByKeyStmt &&
      loadStreamRowForUser(userId, opaqueNormalized)
    ) {
      return opaqueNormalized;
    }
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

  /**
   * CLU-secret authentication path for server-side stream lifecycle management.
   *
   * When `config.server.cluSecret` is set, CLU can authenticate stream API calls
   * by sending `X-CLU-Secret: <secret>` instead of a bearer JWT. This removes
   * the dependency on the iOS bearer token for provider-side stream operations.
   *
   * The target userId is taken from `X-CLU-User-Id` header when present; otherwise
   * falls back to the first admin user in the allowlist (single-user deployments).
   *
   * Spec reference: shared-workspace/clawline/specs/stream-lifecycle.md §5 Auth Model.
   */
  function authenticateCluSecretRequest(
    req: http.IncomingMessage,
    cluSecretRaw: string,
  ): { deviceId: string; userId: string; isAdmin: true } | null {
    const cluSecret = cluSecretRaw.trim();
    if (!cluSecret) {
      return null;
    }
    const incomingRaw = req.headers["x-clu-secret"];
    const incoming = (Array.isArray(incomingRaw) ? incomingRaw[0] : incomingRaw) ?? "";
    if (!timingSafeStringEqual(incoming.trim(), cluSecret)) {
      return null;
    }
    // Resolve userId: explicit header first, then first admin from allowlist.
    const userIdRaw = req.headers["x-clu-user-id"];
    const userIdHeader = (Array.isArray(userIdRaw) ? userIdRaw[0] : userIdRaw)?.trim() ?? "";
    if (userIdHeader) {
      return { deviceId: "clu-server", userId: userIdHeader, isAdmin: true };
    }
    // Fall back to first admin (or first) allowlist entry.
    const entries = allowlist.entries;
    const adminEntry = entries.find((e) => e.isAdmin) ?? entries[0];
    if (!adminEntry) {
      return null;
    }
    return { deviceId: "clu-server", userId: adminEntry.userId, isAdmin: true };
  }

  function authenticateStreamHttpRequest(_req: http.IncomingMessage) {
    // Stream API is localhost-only internal — no auth required.
    // Derive userId from the active WebSocket connection.
    for (const [userId, sessions] of userSessions) {
      if (sessions.size > 0) {
        const first = sessions.values().next().value!;
        return {
          deviceId: first.deviceId ?? "ws-derived",
          userId,
          isAdmin: first.isAdmin ?? false,
        };
      }
    }
    throw new HttpError(401, "auth_failed", "No connected sessions");
  }

  function authenticateHttpRequest(req: http.IncomingMessage) {
    // CLU-secret path: allows server-side CLU stream management without iOS bearer token.
    const cluSecret = config.server?.cluSecret;
    if (cluSecret) {
      const cluAuth = authenticateCluSecretRequest(req, cluSecret);
      if (cluAuth) {
        return cluAuth;
      }
      // If X-CLU-Secret header is present but wrong, reject immediately (don't fall through).
      const incomingRaw = req.headers["x-clu-secret"];
      const incoming = (Array.isArray(incomingRaw) ? incomingRaw[0] : incomingRaw) ?? "";
      if (incoming.trim()) {
        throw new HttpError(403, "clu_secret_invalid", "Invalid CLU secret");
      }
    }

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

  function buildStreamTailStateEvent(event: ServerMessage): StreamTailStateServerMessage | null {
    if (
      event.type !== "message" ||
      typeof event.sessionKey !== "string" ||
      event.sessionKey.trim().length === 0 ||
      !SERVER_EVENT_ID_REGEX.test(event.id) ||
      (event.role !== "user" && event.role !== "assistant")
    ) {
      return null;
    }
    return {
      type: "stream_tail_state",
      sessionKey: event.sessionKey,
      lastMessageId: event.id,
      lastMessageRole: event.role,
    };
  }

  async function broadcastStreamTailStateForUser(userId: string, event: ServerMessage) {
    const payload = buildStreamTailStateEvent(event);
    if (!payload) {
      return;
    }
    await broadcastStreamEvent(userId, payload);
  }

  function loadStreamRowForUser(userId: string, sessionKey: string): StreamSessionRow | null {
    const row = selectStreamSessionByKeyStmt.get(userId, sessionKey) as
      | StreamSessionRow
      | undefined;
    return row ?? null;
  }

  function ensureAdoptedStreamSessionForUser(params: {
    userId: string;
    sessionKey: string;
    displayName: string;
    now: number;
  }) {
    const existing = loadStreamRowForUser(params.userId, params.sessionKey);
    if (existing) {
      return;
    }
    const maxOrderRow = selectStreamMaxOrderStmt.get(params.userId) as {
      maxOrder: number | null;
    };
    const nextOrder = (maxOrderRow?.maxOrder ?? -1) + 1;
    // Adopted sessions become regular user-managed streams once Track confirms them.
    insertStreamSessionStmt.run(
      params.userId,
      params.sessionKey,
      params.displayName,
      "custom",
      nextOrder,
      0,
      1,
      params.now,
      params.now,
    );
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
    const sends: Array<Promise<{ session: Session; delivered: boolean }>> = [];
    for (const session of sessions) {
      sends.push(sendJson(session.socket, payload).then((delivered) => ({ session, delivered })));
    }
    const results = await Promise.allSettled(sends);
    for (const result of results) {
      if (result.status === "fulfilled" && !result.value.delivered) {
        removeSession(result.value.session);
      }
    }
  }

  async function handleListStreamsRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const auth = authenticateStreamHttpRequest(req);
    const streams = await ensureStreamsForAuthedUser(auth);
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ streams }));
  }

  function requireAdminTrackAccess(auth: { isAdmin: boolean }) {
    if (!auth.isAdmin) {
      throw new HttpError(403, "forbidden", "Admin access required");
    }
  }

  function buildTrackableSessionDuplicateMarker(entry: TrackableSessionApiEntry): string {
    const sessionKey = entry.sessionKey.trim();
    if (isClawlineCronRunSessionKey(sessionKey)) {
      const runId = sessionKey.split(":").at(-1)?.trim() ?? "";
      if (runId) {
        return runId.slice(0, 8);
      }
    }
    const fallbackSegment =
      sessionKey
        .split(":")
        .findLast((segment) => segment.trim().length > 0)
        ?.trim() ?? "";
    if (fallbackSegment) {
      return fallbackSegment.slice(0, 12);
    }
    return String(entry.updatedAt);
  }

  function disambiguateTrackableSessionDisplayNames(
    sessions: TrackableSessionApiEntry[],
  ): TrackableSessionApiEntry[] {
    const duplicateCounts = new Map<string, number>();
    for (const session of sessions) {
      duplicateCounts.set(session.displayName, (duplicateCounts.get(session.displayName) ?? 0) + 1);
    }
    return sessions.map((session) => {
      if ((duplicateCounts.get(session.displayName) ?? 0) < 2) {
        return session;
      }
      return {
        ...session,
        displayName: `${session.displayName} (${buildTrackableSessionDuplicateMarker(session)})`,
      };
    });
  }

  function loadMergedSessionStoreForClawline(): Record<string, SessionEntry> {
    const mergedStore: Record<string, SessionEntry> = {};
    const storePaths = new Set<string>([sessionStorePath]);
    const clawlineSessionDiscoveryCfg = {
      ...openClawCfg,
      session: {
        ...openClawCfg.session,
        store: sessionStorePath,
      },
    };
    for (const target of resolveAllAgentSessionStoreTargetsSync(clawlineSessionDiscoveryCfg)) {
      storePaths.add(target.storePath);
    }
    for (const storePath of storePaths) {
      const store = loadSessionStore(storePath);
      for (const [sessionKey, entry] of Object.entries(store)) {
        const existing = mergedStore[sessionKey];
        if (!existing || (entry.updatedAt ?? 0) >= (existing.updatedAt ?? 0)) {
          mergedStore[sessionKey] = entry;
        }
      }
    }
    return mergedStore;
  }

  async function loadTrackableSessionsForAuthedUser(auth: {
    userId: string;
    isAdmin: boolean;
    excludedSessionKeys: Set<string>;
  }): Promise<TrackableSessionApiEntry[]> {
    return runPerUserTask(auth.userId, async () =>
      enqueueWriteTask(() => {
        const streams = readStreamSessionsForUser(auth.userId);
        const provisionedKeys = new Set(
          streams.map((stream) => normalizeSessionKey(stream.sessionKey)),
        );
        const sessionStore = loadMergedSessionStoreForClawline();
        const sessions = Object.entries(sessionStore).flatMap(
          ([sessionKey, entry]): TrackableSessionApiEntry[] => {
            const candidateKey = sessionKey.trim();
            if (!candidateKey) {
              return [];
            }
            const normalizedCandidateKey = normalizeSessionKey(candidateKey);
            if (auth.excludedSessionKeys.has(normalizedCandidateKey)) {
              return [];
            }
            if (provisionedKeys.has(normalizedCandidateKey)) {
              return [];
            }
            if (normalizedCandidateKey.includes(":clawline:")) {
              return [];
            }
            return [
              {
                sessionKey: candidateKey,
                displayName:
                  sanitizeLabel(entry.displayName) ?? sanitizeLabel(entry.label) ?? candidateKey,
                updatedAt: entry.updatedAt,
                channel: typeof entry.channel === "string" ? entry.channel : undefined,
                lastChannel: typeof entry.lastChannel === "string" ? entry.lastChannel : undefined,
                lastTo: typeof entry.lastTo === "string" ? entry.lastTo : undefined,
              },
            ];
          },
        );
        return disambiguateTrackableSessionDisplayNames(sessions).toSorted((a, b) => {
          if (a.updatedAt !== b.updatedAt) {
            return b.updatedAt - a.updatedAt;
          }
          return a.sessionKey.localeCompare(b.sessionKey);
        });
      }),
    );
  }

  async function handleListTrackableSessionsRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) {
    const auth = authenticateStreamHttpRequest(req);
    requireAdminTrackAccess(auth);
    const excludedSessionKeys = new Set(
      new URL(req.url ?? "", "http://localhost").searchParams
        .getAll("excludeSessionKey")
        .map((key) => normalizeSessionKey(key))
        .filter((key) => key.length > 0),
    );
    const sessions = await loadTrackableSessionsForAuthedUser({
      ...auth,
      excludedSessionKeys,
    });
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ sessions }));
  }

  function loadSessionStoreEntryForKey(sessionKey: string): {
    normalizedSessionKey: string;
    entry: ReturnType<typeof resolveSessionStoreEntry>["existing"];
  } {
    const store = loadMergedSessionStoreForClawline();
    const resolved = resolveSessionStoreEntry({ store, sessionKey });
    return {
      normalizedSessionKey: resolved.normalizedKey,
      entry: resolved.existing,
    };
  }

  type AlertSessionStoreSignature = {
    storePath: string;
    exists: boolean;
    size: number;
    mtimeMs: number;
  };

  let alertFallbackSessionIndex: {
    signatures: AlertSessionStoreSignature[];
    keysByNormalized: Map<string, string>;
  } | null = null;

  function resolveAlertFallbackStorePaths(): string[] {
    const storePaths = new Set<string>([sessionStorePath]);
    const clawlineSessionDiscoveryCfg = {
      ...openClawCfg,
      session: {
        ...openClawCfg.session,
        store: sessionStorePath,
      },
    };
    for (const target of resolveAllAgentSessionStoreTargetsSync(clawlineSessionDiscoveryCfg)) {
      storePaths.add(target.storePath);
    }
    return [...storePaths].toSorted();
  }

  async function statAlertFallbackStore(storePath: string): Promise<AlertSessionStoreSignature> {
    try {
      const stats = await fs.stat(storePath);
      return {
        storePath,
        exists: true,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      };
    } catch (err) {
      const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
      if (code !== "ENOENT") {
        logger.warn?.("[clawline] alert_session_store_stat_failed", {
          storePath,
          error: formatError(err),
        });
      }
      return {
        storePath,
        exists: false,
        size: 0,
        mtimeMs: 0,
      };
    }
  }

  function alertFallbackSignaturesEqual(
    a: AlertSessionStoreSignature[],
    b: AlertSessionStoreSignature[],
  ): boolean {
    if (a.length !== b.length) {
      return false;
    }
    return a.every((left, index) => {
      const right = b[index];
      return (
        right !== undefined &&
        left.storePath === right.storePath &&
        left.exists === right.exists &&
        left.size === right.size &&
        left.mtimeMs === right.mtimeMs
      );
    });
  }

  async function loadAlertFallbackSessionIndex(): Promise<Map<string, string>> {
    const signatures = await Promise.all(
      resolveAlertFallbackStorePaths().map((storePath) => statAlertFallbackStore(storePath)),
    );
    if (
      alertFallbackSessionIndex &&
      alertFallbackSignaturesEqual(alertFallbackSessionIndex.signatures, signatures)
    ) {
      return alertFallbackSessionIndex.keysByNormalized;
    }

    const keysByNormalized = new Map<string, string>();
    for (const signature of signatures) {
      if (!signature.exists) {
        continue;
      }
      try {
        const contents = await fs.readFile(signature.storePath, "utf8");
        const parsed = JSON.parse(contents) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          continue;
        }
        for (const rawKey of Object.keys(parsed)) {
          const trimmed = rawKey.trim();
          if (!trimmed) {
            continue;
          }
          keysByNormalized.set(normalizeSessionKey(trimmed), trimmed);
        }
      } catch (err) {
        logger.warn?.("[clawline] alert_session_store_index_failed", {
          storePath: signature.storePath,
          error: formatError(err),
        });
      }
    }
    alertFallbackSessionIndex = { signatures, keysByNormalized };
    return keysByNormalized;
  }

  async function resolveAlertFallbackSessionKey(sessionKey: string): Promise<string | null> {
    const trimmed = sessionKey.trim();
    if (!trimmed) {
      return null;
    }
    const index = await loadAlertFallbackSessionIndex();
    return index.get(normalizeSessionKey(trimmed)) ?? null;
  }

  async function handleAdoptSessionRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const auth = authenticateStreamHttpRequest(req);
    requireAdminTrackAccess(auth);
    const body = await parseStreamsRequestBody(req);
    const requestedSessionKey = typeof body.sessionKey === "string" ? body.sessionKey.trim() : "";
    if (!requestedSessionKey) {
      throw new HttpError(400, "invalid_session_key", "Invalid session key");
    }
    const { normalizedSessionKey, entry } = loadSessionStoreEntryForKey(requestedSessionKey);
    if (!entry) {
      throw new HttpError(404, "stream_not_found", "Stream not found");
    }
    const displayName =
      sanitizeLabel(entry.displayName) ?? sanitizeLabel(entry.label) ?? normalizedSessionKey;
    const stream = await runPerUserTask(auth.userId, async () =>
      enqueueWriteTask(() => {
        const now = nowMs();
        ensureAdoptedStreamSessionForUser({
          userId: auth.userId,
          sessionKey: normalizedSessionKey,
          displayName,
          now,
        });
        insertAdoptedSessionStmt.run(auth.userId, normalizedSessionKey, now);
        const adoptedKeys = readAdoptedSessionKeysForUser(auth.userId);
        const streams = readStreamSessionsForUser(auth.userId);
        syncUserSessionSubscriptions(auth.userId, streams, adoptedKeys);
        const row = loadStreamRowForUser(auth.userId, normalizedSessionKey);
        if (!row) {
          throw new HttpError(500, "server_error", "Created stream is missing");
        }
        return streamSessionFromRow(row);
      }),
    );
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ stream }));
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
    const auth = authenticateStreamHttpRequest(req);
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
    const auth = authenticateStreamHttpRequest(req);
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
    const auth = authenticateStreamHttpRequest(req);
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
        if (existing.adopted === 1) {
          // Untrack: remove stream row + adopted_sessions row, but don't delete messages/assets
          deleteStreamSessionStmt.run(auth.userId, sessionKey);
          db!
            .prepare(`DELETE FROM adopted_sessions WHERE userId = ? AND sessionKey = ?`)
            .run(auth.userId, sessionKey);
          const synced = ensureStreamSessionsForUser({
            userId: auth.userId,
            isAdmin: auth.isAdmin,
          });
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
        }
        if (visibleStreams.length <= 1) {
          throw new HttpError(409, "last_stream_delete_forbidden", "Cannot delete the last stream");
        }
        const deletedAssetIds = deleteStreamDataTx({
          userId: auth.userId,
          sessionKey,
        });
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

  async function sendReplay(
    session: Session,
    lastMessageId: string | null,
    replayCursorsBySessionKey: Record<string, unknown>,
  ) {
    const expectedMainStreamSessionKey = buildClawlinePersonalSessionKey(
      mainSessionAgentId,
      session.userId,
    );
    const expectedGlobalSessionKey = mainSessionKey;
    const allowedSessionKeys = new Set(
      session.provisionedSessionKeys.map((sessionKey) => normalizeSessionKey(sessionKey)),
    );
    const normalizeEventRouting = (event: ServerMessage): void => {
      const rawSessionKey = typeof event.sessionKey === "string" ? event.sessionKey.trim() : "";
      const normalizedOpaqueSessionKey = rawSessionKey ? normalizeSessionKey(rawSessionKey) : "";
      if (
        normalizedOpaqueSessionKey &&
        allowedSessionKeys.has(normalizedOpaqueSessionKey) &&
        !normalizedOpaqueSessionKey.includes(":clawline:")
      ) {
        event.sessionKey = normalizedOpaqueSessionKey;
        return;
      }
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
    const normalizeReplayAnchorSessionKey = (rawSessionKey: string, fallbackUserId: string) => {
      if (!rawSessionKey.trim()) {
        return "";
      }
      const normalizedOpaqueSessionKey = rawSessionKey.trim()
        ? normalizeSessionKey(rawSessionKey)
        : "";
      if (
        normalizedOpaqueSessionKey &&
        allowedSessionKeys.has(normalizedOpaqueSessionKey) &&
        !normalizedOpaqueSessionKey.includes(":clawline:")
      ) {
        return normalizedOpaqueSessionKey;
      }
      const normalized = normalizeStoredSessionKey(rawSessionKey, fallbackUserId);
      return normalized && allowedSessionKeys.has(normalizeSessionKey(normalized))
        ? normalized
        : "";
    };
    type ReplayAnchor = {
      userId: string;
      sessionKey: string;
      sequence: number;
      timestamp: number;
    };
    const loadReplayAnchor = (messageId: string): ReplayAnchor | null => {
      if (!SERVER_EVENT_ID_REGEX.test(messageId)) {
        return null;
      }
      const anchorRow = selectEventByIdStmt.get(messageId) as
        | {
            id: string;
            userId: string;
            sessionKey: string | null;
            sequence: number;
            timestamp: number;
          }
        | undefined;
      if (!anchorRow) {
        return null;
      }
      const anchorSessionKey = normalizeReplayAnchorSessionKey(
        anchorRow.sessionKey ?? "",
        anchorRow.userId,
      );
      if (!anchorSessionKey) {
        return null;
      }
      return {
        userId: anchorRow.userId,
        sessionKey: anchorSessionKey,
        sequence: anchorRow.sequence,
        timestamp: anchorRow.timestamp,
      };
    };
    const legacyAnchor = lastMessageId ? loadReplayAnchor(lastMessageId) : null;
    const explicitCursorBySessionKey = new Map<
      string,
      { cursor: string | null; suppressLegacyFallback: boolean }
    >();
    for (const [rawSessionKey, rawCursor] of Object.entries(replayCursorsBySessionKey)) {
      const normalizedSessionKey = normalizeSessionKey(rawSessionKey);
      if (!normalizedSessionKey || !allowedSessionKeys.has(normalizedSessionKey)) {
        continue;
      }
      if (typeof rawCursor !== "string") {
        explicitCursorBySessionKey.set(normalizedSessionKey, {
          cursor: null,
          suppressLegacyFallback: true,
        });
        continue;
      }
      const cursor = rawCursor.trim();
      if (!cursor) {
        explicitCursorBySessionKey.set(normalizedSessionKey, {
          cursor: null,
          suppressLegacyFallback: true,
        });
        continue;
      }
      explicitCursorBySessionKey.set(normalizedSessionKey, {
        cursor,
        suppressLegacyFallback: true,
      });
    }
    // Debug logging for duplicate investigation
    logger.info("replay_start", {
      deviceId: session.deviceId,
      userId: session.userId,
      lastMessageId: lastMessageId ?? "(null)",
      legacyAnchorFound: !!legacyAnchor,
      legacyAnchorSequence: legacyAnchor?.sequence,
      replayCursorCount: explicitCursorBySessionKey.size,
    });
    const replayCap = config.sessions.maxReplayMessagesPerStream;
    const replayLimit = Math.max(0, replayCap) + 1;
    let replayTruncated = false;
    let historyReset = false;
    const selected: Array<{ event: ServerMessage; sequence: number }> = [];
    const replaySessionKeys = dedupeKeys(
      session.sessionKeys.length > 0 ? session.sessionKeys : session.provisionedSessionKeys,
    );
    for (const sessionKey of replaySessionKeys) {
      const normalizedSessionKey = normalizeSessionKey(sessionKey);
      const explicitCursor = explicitCursorBySessionKey.get(normalizedSessionKey);
      const explicitAnchor =
        explicitCursor?.cursor !== null && explicitCursor?.cursor !== undefined
          ? loadReplayAnchor(explicitCursor.cursor)
          : null;
      const explicitAnchorUsable =
        explicitAnchor !== null &&
        explicitAnchor.userId === session.userId &&
        sessionKeyEq(explicitAnchor.sessionKey, normalizedSessionKey);
      const legacyAnchorUsable =
        !explicitCursor?.suppressLegacyFallback &&
        legacyAnchor !== null &&
        legacyAnchor.userId === session.userId &&
        sessionKeyEq(legacyAnchor.sessionKey, normalizedSessionKey);
      const anchor = explicitAnchorUsable
        ? explicitAnchor
        : legacyAnchorUsable
          ? legacyAnchor
          : null;
      if (!anchor) {
        historyReset = true;
      }
      const rowsDesc = (
        anchor
          ? selectEventsAfterBySessionStmt.all(
              session.userId,
              normalizedSessionKey,
              anchor.sequence,
              replayLimit,
            )
          : selectEventsTailBySessionStmt.all(session.userId, normalizedSessionKey, replayLimit)
      ) as EventRow[];
      const rows = rowsDesc.length > replayCap ? rowsDesc.slice(0, replayCap) : rowsDesc;
      if (rowsDesc.length > replayCap) {
        replayTruncated = true;
      }
      const parsed = rows
        .toReversed()
        .map((row) => parseServerMessage(row.payloadJson, logger))
        .map((event, index) => ({ event, row: rows[rows.length - 1 - index] }))
        .filter(
          (entry): entry is { event: ServerMessage; row: EventRow } =>
            Boolean(entry.event) && Boolean(entry.row),
        )
        .map(({ event, row }) => {
          event.attachments = canonicalizeReplayAttachments(event.attachments, logger, event.id);
          normalizeEventRouting(event);
          return { event, sequence: row.sequence ?? 0 };
        });
      selected.push(...parsed);
    }
    selected.sort((a, b) => a.event.timestamp - b.event.timestamp || a.sequence - b.sequence);
    const limited = selected.map(({ event }) => event);
    const sessionInfo = buildSessionInfo(
      session.userId,
      session.isAdmin,
      session.adoptedSessionKeys,
    );
    const payload = {
      type: "auth_result",
      success: true,
      userId: session.userId,
      sessionId: session.sessionId,
      isAdmin: session.isAdmin,
      replayCount: limited.length,
      replayTruncated,
      historyReset,
      features: buildAuthResultFeatures(session),
      dmScope: sessionInfo.dmScope,
      sessionKeys: sessionInfo.streamSessionKeys,
      streamReadStates: readStreamReadStatesForUser(session.userId, sessionInfo.streamSessionKeys),
      streamTailStates: readStreamTailStatesForUser(session.userId, sessionInfo.streamSessionKeys),
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
    const abortReplay = () => {
      session.replayInProgress = false;
      session.replayBufferedMessages = [];
      session.resolveReplayBarrier();
      removeSession(session);
      connectionState.delete(session.socket);
      if (
        session.socket.readyState !== WebSocket.CLOSED &&
        session.socket.readyState !== WebSocket.CLOSING
      ) {
        session.socket.close();
      }
    };
    if (!(await sendJson(session.socket, payload).catch(() => false))) {
      abortReplay();
      return;
    }
    if (
      !(await sendJson(session.socket, { type: "stream_snapshot", streams }).catch(() => false))
    ) {
      abortReplay();
      return;
    }
    if (!(await sendSessionInfo(session, sessionInfo))) {
      abortReplay();
      return;
    }
    const sendReplayMessage = async (event: ServerMessage, replay: boolean): Promise<boolean> => {
      if (session.replayDeliveredMessageIds.has(event.id)) {
        return true;
      }
      const normalized = normalizePayloadForSession(session, event, mainSessionKey.toLowerCase());
      if (!normalized) {
        return true;
      }
      logger.info(replay ? "replay_send" : "replay_gap_fill_send", {
        deviceId: session.deviceId,
        userId: session.userId,
        messageId: normalized.id,
        sessionKey: normalized.sessionKey,
        streaming: normalized.streaming,
        attachmentCount: Array.isArray(normalized.attachments) ? normalized.attachments.length : 0,
        replay,
      });
      const replayTerminalFilteredCount =
        countTerminalSessionDocumentAttachments(event.attachments) -
        countTerminalSessionDocumentAttachments(normalized.attachments);
      if (replayTerminalFilteredCount > 0) {
        logger.warn?.("[clawline] terminal_attachment_filtered_for_client_feature", {
          deviceId: session.deviceId,
          userId: session.userId,
          messageId: normalized.id,
          sessionKey: normalized.sessionKey,
          filteredCount: replayTerminalFilteredCount,
          replay,
          reason: "missing_terminal_bubbles_v1",
        });
      }
      const stats = summarizeAttachmentStats(normalized.attachments);
      if (stats) {
        logger.info?.(
          `[clawline:http] ws_send_message attachmentCount=${stats.count} inlineBytes=${stats.inlineBytes} assetCount=${stats.assetCount} replay=${String(replay)}`,
          {
            deviceId: session.deviceId,
            userId: session.userId,
            messageId: normalized.id,
            attachmentCount: stats.count,
            inlineBytes: stats.inlineBytes,
            assetCount: stats.assetCount,
            streaming: normalized.streaming,
            replay,
          },
        );
      }
      if (!(await sendJson(session.socket, normalized).catch(() => false))) {
        return false;
      }
      if (!normalized.streaming) {
        session.replayDeliveredMessageIds.add(normalized.id);
      }
      return true;
    };
    for (const event of limited) {
      if (!(await sendReplayMessage(event, true))) {
        abortReplay();
        return;
      }
    }
    while (session.replayBufferedMessages.length > 0) {
      const buffered = session.replayBufferedMessages.shift();
      if (!buffered) {
        continue;
      }
      if (!(await sendReplayMessage(buffered, false))) {
        abortReplay();
        return;
      }
    }
    session.replayInProgress = false;
    session.replayBufferedMessages = [];
    if (!(await sendJson(session.socket, { type: "sync_complete" }).catch(() => false))) {
      abortReplay();
      return;
    }
    session.resolveReplayBarrier();
  }

  function sendPayloadToSession(session: Session, payload: ServerMessage) {
    const normalized = normalizePayloadForSession(session, payload, mainSessionKey.toLowerCase());
    if (!normalized) {
      logger.warn?.("[clawline] outbound_delivery_skipped", {
        reason: "normalize_payload_nil",
        payloadMessageId: payload.id,
        payloadSessionKey: payload.sessionKey,
        deviceId: session.deviceId,
        sessionId: session.sessionId,
      });
      return;
    }
    const terminalFilteredCount =
      countTerminalSessionDocumentAttachments(payload.attachments) -
      countTerminalSessionDocumentAttachments(normalized.attachments);
    if (terminalFilteredCount > 0) {
      logger.warn?.("[clawline] terminal_attachment_filtered_for_client_feature", {
        deviceId: session.deviceId,
        userId: session.userId,
        messageId: normalized.id,
        sessionKey: normalized.sessionKey,
        filteredCount: terminalFilteredCount,
        replay: false,
        reason: "missing_terminal_bubbles_v1",
      });
    }
    if (session.socket.readyState !== WebSocket.OPEN) {
      logger.warn?.("[clawline] outbound_delivery_skipped", {
        reason: "socket_not_open",
        payloadMessageId: normalized.id,
        payloadSessionKey: normalized.sessionKey,
        deviceId: session.deviceId,
        sessionId: session.sessionId,
        socketState: socketStateLabel(session.socket),
      });
      removeSession(session);
      return;
    }
    logger.info?.("[clawline] outbound_delivery_attempt", {
      payloadMessageId: normalized.id,
      payloadSessionKey: normalized.sessionKey,
      role: normalized.role ?? "assistant",
      streaming: normalized.streaming,
      deviceId: session.deviceId,
      sessionId: session.sessionId,
      subscribedSessionKeys: session.sessionKeys,
      socketState: socketStateLabel(session.socket),
      contentLength: typeof normalized.content === "string" ? normalized.content.trim().length : 0,
      attachmentCount: Array.isArray(normalized.attachments) ? normalized.attachments.length : 0,
    });
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
        logger.warn?.("[clawline] outbound_delivery_send_failed", {
          payloadMessageId: normalized.id,
          payloadSessionKey: normalized.sessionKey,
          deviceId: session.deviceId,
          sessionId: session.sessionId,
          socketState: socketStateLabel(session.socket),
          error: formatError(err),
        });
        removeSession(session);
        session.socket.close();
        return;
      }
      logger.info?.("[clawline] outbound_delivery_send_ok", {
        payloadMessageId: normalized.id,
        payloadSessionKey: normalized.sessionKey,
        role: normalized.role ?? "assistant",
        streaming: normalized.streaming,
        deviceId: session.deviceId,
        sessionId: session.sessionId,
      });
      const role = normalized.role ?? "assistant";
      const streaming = normalized.streaming;
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
    let matchedTargets = 0;
    for (const target of sessionsByDevice.values()) {
      if (target.revoked || isDenylisted(target.deviceId)) {
        continue;
      }
      const keys = resolveSubscribedSessionKeys(target);
      if (!keys.some((key) => key.toLowerCase() === normalizedKey)) {
        continue;
      }
      matchedTargets += 1;
      if (target.replayInProgress) {
        if (target.replayDeliveredMessageIds.has(payload.id)) {
          continue;
        }
        const existingIndex = target.replayBufferedMessages.findIndex(
          (message) => message.id === payload.id,
        );
        if (existingIndex >= 0) {
          const existing = target.replayBufferedMessages[existingIndex];
          if (existing?.streaming || payload.streaming) {
            target.replayBufferedMessages[existingIndex] = { ...payload };
          }
        } else {
          target.replayBufferedMessages.push({ ...payload });
        }
        continue;
      }
      sendPayloadToSession(target, payload);
    }
    logger.info?.("[clawline] outbound_broadcast_result", {
      payloadMessageId: payload.id,
      payloadSessionKey: payload.sessionKey,
      matchedTargets,
    });
  }

  async function appendEvent(
    event: ServerMessage,
    userId: string,
    originatingDeviceId?: string,
    options: { preserveOpaqueSessionKey?: boolean } = {},
  ) {
    return enqueueWriteTask(() =>
      insertEventTx(event, userId, originatingDeviceId, options.preserveOpaqueSessionKey === true),
    );
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
    options: {
      preserveOpaqueSessionKey?: boolean;
      replyToMessageId?: string;
      replyToClientMessageId?: string;
    } = {},
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
      replyToMessageId: options.replyToMessageId,
      replyToClientMessageId: options.replyToClientMessageId,
      attachments:
        filteredAttachments && filteredAttachments.length > 0 ? filteredAttachments : undefined,
    };
    await appendEvent(event, targetUserId, undefined, options);
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
      target = await resolveSessionTargetFromSessionKey(normalizedTargetInput);
      if (target.kind === "session") {
        sessionKeyHint = target.sessionKey;
      } else {
        sessionKeyHint = normalizedTargetInput;
      }
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
      try {
        outboundAttachments = await materializeOutboundAttachments({
          attachments: rawAttachments,
          ownerUserId: target.userId,
          uploaderDeviceId: target.kind === "device" ? target.deviceId : "server",
        });
      } catch (err) {
        logger.warn?.(`[clawline] outbound_attachment_materialize_failed: ${formatError(err)}`);
      }
    } else if (mediaUrl) {
      try {
        outboundAttachments = await materializeOutboundMediaUrls({
          mediaUrls: [mediaUrl],
          ownerUserId: target.userId,
          uploaderDeviceId: target.kind === "device" ? target.deviceId : "server",
        });
      } catch (err) {
        logger.warn?.(`[clawline] outbound_media_attachment_failed: ${formatError(err)}`);
      }
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
      replyToMessageId: params.replyToMessageId,
      replyToClientMessageId: params.replyToClientMessageId,
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
    await broadcastStreamTailStateForUser(target.userId, event);
    return {
      messageId: event.id,
      userId: target.userId,
      deviceId: target.kind === "device" ? target.deviceId : undefined,
      attachments: outboundAttachments.attachments,
      assetIds: outboundAttachments.assetIds,
    };
  }

  function removeSession(session: Session) {
    if (sessionsByDevice.get(session.deviceId) === session) {
      sessionsByDevice.delete(session.deviceId);
    }
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
      sessionFile: resolveClawlineSessionTranscriptPath(session.sessionId, mainSessionAgentId),
      displayName: session.claimedName ?? session.deviceInfo?.model ?? null,
      logger,
    });
  }

  type InboundMessageTarget =
    | {
        kind: "clawline";
        resolvedSessionKey: string;
        streamSuffix: string;
        routeAgentId: string;
        channelLabel: "clawline";
        routeAccountId: string;
        contextTo: string;
        originatingChannel: "clawline";
        originatingTo: string;
        updateLastRoute?:
          | {
              sessionKey: string;
              channel: "clawline";
              to: string;
              accountId: string;
            }
          | undefined;
      }
    | {
        kind: "adopted";
        resolvedSessionKey: string;
        routeAgentId: string;
        channelLabel: string;
        routeAccountId: string;
        contextTo: string;
        originatingChannel: string;
        originatingTo: string;
        updateLastRoute?: undefined;
      };

  const normalizeChannelLabel = (value: unknown): string => {
    if (typeof value !== "string") {
      return "";
    }
    return value.trim().toLowerCase();
  };

  const resolveAdoptedSessionTarget = (resolvedSessionKey: string): InboundMessageTarget => {
    const { normalizedSessionKey, entry } = loadSessionStoreEntryForKey(resolvedSessionKey);
    if (!entry) {
      throw new ClientMessageError("stream_not_found", "Stream not found");
    }
    const channelLabel =
      normalizeChannelLabel(entry.lastChannel) || normalizeChannelLabel(entry.channel);
    if (!channelLabel) {
      throw new ClientMessageError("stream_not_found", "Stream not found");
    }
    const originatingTo =
      typeof entry.lastTo === "string" && entry.lastTo.trim().length > 0
        ? entry.lastTo.trim()
        : normalizedSessionKey;
    return {
      kind: "adopted",
      resolvedSessionKey: normalizedSessionKey,
      routeAgentId: resolveAgentIdFromSessionKey(normalizedSessionKey),
      channelLabel,
      routeAccountId: DEFAULT_ACCOUNT_ID,
      contextTo: originatingTo,
      originatingChannel: channelLabel,
      originatingTo,
    };
  };

  const resolveInboundMessageTarget = (
    session: Session,
    resolvedSessionKey: string,
  ): InboundMessageTarget => {
    const isAdoptedSessionKey = session.adoptedSessionKeys.some((sessionKey) =>
      sessionKeyEq(sessionKey, resolvedSessionKey),
    );
    let streamSuffix = "main";
    if (sessionKeyEq(resolvedSessionKey, session.personalSessionKey)) {
      streamSuffix = "main";
    } else if (
      session.dmScope !== "main" &&
      sessionKeyEq(resolvedSessionKey, session.dmSessionKey)
    ) {
      streamSuffix = "dm";
    } else if (isAdoptedSessionKey) {
      // Adopted keys are treated as opaque provider sessions, even if the literal
      // session key overlaps the admin/global built-in key (for example agent:main:main).
      return resolveAdoptedSessionTarget(resolvedSessionKey);
    } else if (sessionKeyEq(resolvedSessionKey, session.globalSessionKey)) {
      streamSuffix = "global";
    } else if (!normalizeSessionKey(resolvedSessionKey).includes(":clawline:")) {
      return resolveAdoptedSessionTarget(resolvedSessionKey);
    } else {
      const parsed = parseClawlineUserSessionKey(resolvedSessionKey);
      const normalizedUserId = sanitizeUserId(session.userId).toLowerCase();
      if (!parsed || parsed.userId !== normalizedUserId) {
        throw new ClientMessageError("stream_not_found", "Stream not found");
      }
      streamSuffix = parsed.streamSuffix;
    }
    const deliveryTarget = ClawlineDeliveryTarget.fromParts(session.userId, streamSuffix);
    return {
      kind: "clawline",
      resolvedSessionKey,
      streamSuffix,
      routeAgentId: resolveAgentIdFromSessionKey(resolvedSessionKey),
      channelLabel: "clawline",
      routeAccountId: DEFAULT_ACCOUNT_ID,
      contextTo: `device:${session.deviceId}`,
      originatingChannel: "clawline",
      originatingTo: deliveryTarget.toString(),
      updateLastRoute:
        streamSuffix === "dm" && session.dmScope !== "main"
          ? {
              sessionKey: mainSessionKey,
              channel: "clawline",
              to: deliveryTarget.toString(),
              accountId: DEFAULT_ACCOUNT_ID,
            }
          : undefined,
    };
  };

  async function processClientMessage(session: Session, payload: ClientPayload) {
    let processStage = "start";
    const markProcessStage = (stage: string) => {
      processStage = stage;
      logger.info?.(`[clawline] processClientMessage_stage: ${stage}`, {
        messageId: typeof payload?.id === "string" ? payload.id : undefined,
        deviceId: session.deviceId,
        userId: session.userId,
      });
    };
    try {
      markProcessStage("validate_payload");
      if (payload.type !== "message") {
        throw new ClientMessageError("invalid_message", "Unsupported type");
      }
      if (typeof payload.id !== "string" || !payload.id.startsWith("c_")) {
        throw new ClientMessageError("invalid_message", "Invalid id");
      }
      const messageId = payload.id;
      const rawContent = typeof payload.content === "string" ? payload.content : "";
      markProcessStage("normalize_attachments");
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
      markProcessStage("resolve_session_key");
      const payloadSessionKey =
        typeof payload.sessionKey === "string" ? payload.sessionKey.trim() : "";
      const normalizedClawlinePayloadSessionKey = payloadSessionKey
        ? normalizeStreamMutationSessionKeyForUser(session.userId, payloadSessionKey)
        : "";
      const normalizedAdoptedPayloadSessionKey =
        payloadSessionKey && !normalizedClawlinePayloadSessionKey
          ? normalizeSessionKey(payloadSessionKey)
          : "";
      const allowedSessionKeys = session.provisionedSessionKeys?.length
        ? session.provisionedSessionKeys
        : [session.sessionKey];
      // Legacy clients may omit sessionKey; default to the Main stream session key.
      const resolvedSessionKey =
        normalizedClawlinePayloadSessionKey ||
        normalizedAdoptedPayloadSessionKey ||
        session.sessionKey;
      if (
        !allowedSessionKeys.some(
          (sessionKey) =>
            normalizeSessionKey(sessionKey) === normalizeSessionKey(resolvedSessionKey),
        )
      ) {
        throw new ClientMessageError("stream_not_found", "Stream not found");
      }
      const inboundTarget = resolveInboundMessageTarget(session, resolvedSessionKey);
      markProcessStage("route_inbound_message");
      logger.info?.("[clawline] inbound message routing", {
        messageId,
        payloadSessionKey: payload.sessionKey,
        resolvedSessionKey,
        targetKind: inboundTarget.kind,
        streamSuffix: inboundTarget.kind === "clawline" ? inboundTarget.streamSuffix : undefined,
        sessionIsAdmin: session.isAdmin,
        userId: session.userId,
        deviceId: session.deviceId,
        sessionKey: session.sessionKey,
      });
      if (
        inboundTarget.kind === "clawline" &&
        inboundTarget.streamSuffix === "global" &&
        !session.isAdmin
      ) {
        throw new ClientMessageError("forbidden", "Admin channel requires admin access");
      }
      const targetUserId = session.userId;

      let runAgentDispatch: (() => Promise<void>) | null = null;
      markProcessStage("run_per_user_task");
      await runPerUserTask(
        session.userId,
        async () => {
          if (isDenylisted(session.deviceId)) {
            throw new ClientMessageError("token_revoked", "Device revoked");
          }
          markProcessStage("duplicate_lookup");
          const existing = selectMessageStmt.get(session.deviceId, messageId) as
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
              session.socket.send(JSON.stringify({ type: "ack", id: messageId }), (err) => {
                if (!err) {
                  markAckSent(session.deviceId, messageId);
                  return;
                }
                logger.warn?.(`[clawline] ack_send_failed: ${formatError(err)}`, {
                  messageId,
                  deviceId: session.deviceId,
                });
              });
            } else {
              session.socket.send(JSON.stringify({ type: "ack", id: messageId }), (err) => {
                if (err) {
                  logger.warn?.(`[clawline] duplicate_ack_send_failed: ${formatError(err)}`, {
                    messageId,
                    deviceId: session.deviceId,
                  });
                }
              });
            }
            return;
          }

          markProcessStage("message_rate_limit");
          if (!messageRateLimiter.attempt(session.deviceId)) {
            throw new ClientMessageError("rate_limited", "Too many messages");
          }

          markProcessStage("materialize_inline_attachments");
          const materialized = await materializeInlineAttachments({
            attachments: attachmentsInfo.attachments,
            ownerUserId: targetUserId,
            deviceId: session.deviceId,
          });
          markProcessStage("ensure_attachment_ownership");
          const assetIds = attachmentsInfo.assetIds.concat(materialized.inlineAssetIds);
          const ownership = await ensureChannelAttachmentOwnership({
            attachments: materialized.attachments,
            assetIds,
            session,
          });
          if (isDenylisted(session.deviceId)) {
            throw new ClientMessageError("token_revoked", "Device revoked");
          }

          markProcessStage("persist_user_message");
          const { event } = await persistUserMessage(
            session,
            targetUserId,
            messageId,
            rawContent,
            ownership.attachments,
            attachmentsHash,
            ownership.assetIds,
            resolvedSessionKey,
          );
          if (markMessageFailedIfDeviceRevoked(session.deviceId, messageId)) {
            return;
          }
          markProcessStage("send_ack");
          await new Promise<void>((resolve) => {
            session.socket.send(JSON.stringify({ type: "ack", id: messageId }), (err) => {
              if (!err) {
                markAckSent(session.deviceId, messageId);
              } else {
                logger.warn?.(`[clawline] ack_send_failed: ${formatError(err)}`, {
                  messageId,
                  deviceId: session.deviceId,
                });
              }
              resolve();
            });
          });
          markProcessStage("broadcast_user_message");
          broadcastToSessionKey(resolvedSessionKey, event);
          await broadcastStreamTailStateForUser(targetUserId, event);

          const attachmentSummary = describeClawlineAttachments(ownership.attachments);
          const inboundBody = attachmentSummary
            ? `${rawContent}\n\n${attachmentSummary}`
            : rawContent;
          markProcessStage("load_inbound_images");
          const inboundImages = await clawlineAttachmentsToImages(ownership.attachments, {
            loadAssetImage: loadInboundAssetImage,
          });

          markProcessStage("build_delivery_context");
          const routeSessionKey = resolvedSessionKey;
          const route = {
            agentId: inboundTarget.routeAgentId,
            channel: inboundTarget.channelLabel,
            accountId: inboundTarget.routeAccountId,
            sessionKey: routeSessionKey,
            mainSessionKey,
          };
          const peerId = session.peerId;
          const groupSystemPrompt = adapterOverrides.systemPrompt?.trim() || undefined;
          const ctxPayload = finalizeInboundContext({
            Body: inboundBody,
            RawBody: rawContent,
            CommandBody: rawContent,
            From: `${inboundTarget.channelLabel}:${peerId}`,
            To: inboundTarget.contextTo,
            SessionKey: route.sessionKey,
            AccountId: route.accountId,
            MessageSid: messageId,
            ChatType: "direct",
            SenderName: session.claimedName ?? session.deviceInfo?.model ?? peerId,
            SenderId: session.userId,
            Provider: inboundTarget.channelLabel,
            Surface: inboundTarget.channelLabel,
            NativeChannelId: inboundTarget.originatingTo,
            OriginatingChannel: inboundTarget.originatingChannel,
            OriginatingTo: inboundTarget.originatingTo,
            GroupSystemPrompt: groupSystemPrompt,
            CommandAuthorized: true,
          });
          markProcessStage("record_inbound_session");
          await recordInboundSession({
            storePath: sessionStorePath,
            sessionKey: route.sessionKey,
            ctx: ctxPayload,
            updateLastRoute: inboundTarget.updateLastRoute,
            onRecordError: (err) => {
              logger.warn?.(`[clawline] failed recording inbound session: ${formatError(err)}`);
            },
          });

          const fallbackText = adapterOverrides.responseFallback?.trim() ?? "";
          const prefixContext: ClawlineResponsePrefixContext = {
            identityName: resolveIdentityName(route.agentId),
          };

          // Track activity state for typing indicator
          let activitySignaled = false;
          const sendActivitySignal = async (isActive: boolean) => {
            logger.info?.("[clawline] activity_signal", {
              isActive,
              messageId,
              sessionKey: route.sessionKey,
            });
            await sendJson(session.socket, {
              type: "event",
              event: "activity",
              payload: {
                isActive,
                messageId,
                sessionKey: route.sessionKey,
              },
            }).catch(() => {});
          };

          markProcessStage("create_reply_dispatcher");
          const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
            responsePrefix: resolveEffectiveMessagesConfig(openClawCfg, route.agentId)
              .responsePrefix,
            responsePrefixContextProvider: () => prefixContext,
            humanDelay: resolveHumanDelayConfig(openClawCfg, route.agentId),
            deliver: async (replyPayload) => {
              const deliverStartedAt = Date.now();
              logger.info?.("[clawline] agent_run_phase", {
                phase: "deliver_start",
                messageId,
                sessionKey: resolvedSessionKey,
                hasText: Boolean(replyPayload.text?.trim()),
                mediaUrlCount: replyPayload.mediaUrls?.length ?? (replyPayload.mediaUrl ? 1 : 0),
              });
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
              if (markMessageFailedIfDeviceRevoked(session.deviceId, messageId)) {
                return;
              }
              const assistantEvent = await persistAssistantMessage(
                session,
                targetUserId,
                assistantText,
                route.sessionKey,
                attachments,
                {
                  preserveOpaqueSessionKey: inboundTarget.kind === "adopted",
                  replyToMessageId: event.id,
                  replyToClientMessageId: messageId,
                },
              );
              broadcastToSessionKey(resolvedSessionKey, assistantEvent);
              await broadcastStreamTailStateForUser(targetUserId, assistantEvent);
              logger.info?.("[clawline] agent_run_phase", {
                phase: "deliver_done",
                messageId,
                sessionKey: resolvedSessionKey,
                assistantTextLength: assistantText.length,
                attachmentCount: attachments.length,
                elapsedMs: Date.now() - deliverStartedAt,
              });
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

          markProcessStage("prepare_agent_run");
          runAgentDispatch = async () => {
            markProcessStage("agent_run_start");
            logger.info?.("[clawline] agent_run_start", {
              messageId,
              sessionId: session.sessionId,
              sessionKey: resolvedSessionKey,
              userId: session.userId,
              deviceId: session.deviceId,
            });
            const activeRun: SessionStatusActiveRun = {
              runId: event.id,
              messageId,
              sessionKey: resolvedSessionKey,
              startedAt: Date.now(),
              provider: null,
              model: null,
              thinkingLevel: null,
              fastMode: null,
            };
            activeSessionRuns.set(normalizeSessionKey(resolvedSessionKey), activeRun);

            let queuedFinal = false;
            let deliveredCount = 0;
            const dispatchStartedAt = Date.now();
            try {
              logger.info?.("[clawline] agent_run_phase", {
                phase: "dispatch_start",
                messageId,
                sessionKey: resolvedSessionKey,
                imageCount: inboundImages.length,
              });
              const result = await runWithClawlineOutboundCorrelation(
                {
                  replyToMessageId: event.id,
                  replyToClientMessageId: messageId,
                },
                () =>
                  dispatchInboundMessage({
                    ctx: ctxPayload,
                    cfg: openClawCfg,
                    dispatcher,
                    replyOptions: {
                      ...replyOptions,
                      images: inboundImages.length > 0 ? inboundImages : undefined,
                      onModelSelected: (ctx) => {
                        prefixContext.provider = ctx.provider;
                        prefixContext.model = extractClawlineShortModelName(ctx.model);
                        prefixContext.modelFull = `${ctx.provider}/${ctx.model}`;
                        prefixContext.thinkingLevel = ctx.thinkLevel ?? "off";
                        prefixContext.fastMode = ctx.fastMode;
                        activeRun.provider = ctx.provider;
                        activeRun.model = ctx.model;
                        activeRun.thinkingLevel = ctx.thinkLevel ?? "off";
                        activeRun.fastMode = ctx.fastMode ?? null;
                        rememberSessionRuntimeStatus(resolvedSessionKey, {
                          provider: ctx.provider,
                          model: ctx.model,
                          thinkingLevel: ctx.thinkLevel ?? "off",
                          fastMode: ctx.fastMode ?? null,
                        });
                      },
                    },
                    replyResolver: options.replyResolver,
                  }),
              );
              queuedFinal = result.queuedFinal;
              // Count all delivered content (streaming blocks, tool results, and final replies)
              deliveredCount = result.counts.block + result.counts.tool + result.counts.final;
              logger.info?.("[clawline] agent_run_phase", {
                phase: "dispatch_return",
                messageId,
                sessionKey: resolvedSessionKey,
                queuedFinal,
                deliveredCount,
                blockCount: result.counts.block,
                toolCount: result.counts.tool,
                finalCount: result.counts.final,
                elapsedMs: Date.now() - dispatchStartedAt,
              });
            } catch (err) {
              logger.error?.(`[clawline] dispatch_failed: ${formatError(err)}`);
              queuedFinal = false;
            }
            const waitForIdleStartedAt = Date.now();
            logger.info?.("[clawline] agent_run_phase", {
              phase: "wait_for_idle_start",
              messageId,
              sessionKey: resolvedSessionKey,
            });
            markDispatchIdle();
            await dispatcher.waitForIdle();
            logger.info?.("[clawline] agent_run_phase", {
              phase: "wait_for_idle_done",
              messageId,
              sessionKey: resolvedSessionKey,
              elapsedMs: Date.now() - waitForIdleStartedAt,
            });

            // Always send activity=false when done
            if (activitySignaled) {
              activitySignaled = false;
              void sendActivitySignal(false);
            }
            if (markMessageFailedIfDeviceRevoked(session.deviceId, messageId)) {
              return;
            }

            // Check if message was successfully handled:
            // 1. queuedFinal = true means a final reply was sent
            // 2. deliveredCount > 0 means content was streamed (blocks/tools)
            // 3. queueDepth > 0 means message was queued for later processing
            const queueKey = route.sessionKey;
            const queueDepth = getClawlineFollowupQueueDepth(queueKey);
            const wasDelivered = queuedFinal || deliveredCount > 0;
            const wasQueued = !wasDelivered && queueDepth > 0;

            logger.info?.("[clawline] agent_run_end", {
              messageId,
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
              logger.warn?.("[clawline] agent_run_no_delivery", {
                messageId,
                sessionId: session.sessionId,
                sessionKey: resolvedSessionKey,
                userId: session.userId,
                deviceId: session.deviceId,
                deliveredCount,
                queuedFinal,
                queueDepth,
              });
              updateMessageStreamingStmt.run(
                MessageStreamingState.Failed,
                session.deviceId,
                messageId,
              );
              const errorSent = await sendJson(session.socket, {
                type: "error",
                code: "server_error",
                message: "Unable to deliver reply",
                messageId,
              }).catch(() => false);
              logger.warn?.("[clawline] agent_run_no_delivery_error_emit", {
                messageId,
                sessionKey: resolvedSessionKey,
                deviceId: session.deviceId,
                errorSent,
              });
              activeSessionRuns.delete(normalizeSessionKey(resolvedSessionKey));
              return;
            }

            // Message was either delivered or queued successfully
            updateMessageStreamingStmt.run(
              wasQueued ? MessageStreamingState.Queued : MessageStreamingState.Finalized,
              session.deviceId,
              messageId,
            );
            activeSessionRuns.delete(normalizeSessionKey(resolvedSessionKey));
          };
          markProcessStage("dispatch_agent_run");
          await runAgentDispatch();
          runAgentDispatch = null;
        },
        { streamKey: resolvedSessionKey },
      );
      const dispatchAgentRun = runAgentDispatch as (() => Promise<void>) | null;
      if (!dispatchAgentRun) {
        return;
      }
      markProcessStage("dispatch_agent_run");
      await dispatchAgentRun();
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
      const formattedError = formatError(err);
      logger.error?.(
        `[clawline] processClientMessage_unexpected_error stage=${processStage}: ${formattedError}`,
        {
          messageId: payload?.id,
          userId: session.userId,
          deviceId: session.deviceId,
        },
      );
      await sendJson(session.socket, {
        type: "error",
        code: "server_error",
        message: "Message processing failed",
        messageId: payload?.id,
      }).catch(() => {});
    }
  }

  async function processInteractiveCallback(session: Session, payload: ClientPayload) {
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

      let runAgentDispatch: (() => Promise<void>) | null = null;
      await runPerUserTask(
        session.userId,
        async () => {
          if (isDenylisted(session.deviceId)) {
            throw new ClientMessageError("token_revoked", "Device revoked");
          }
          if (!messageRateLimiter.attempt(session.deviceId)) {
            throw new ClientMessageError("rate_limited", "Too many messages");
          }

          const clientId = `c_${randomUUID()}`;
          if (isDenylisted(session.deviceId)) {
            throw new ClientMessageError("token_revoked", "Device revoked");
          }

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
          if (markMessageFailedIfDeviceRevoked(session.deviceId, clientId)) {
            return;
          }
          broadcastToSessionKey(resolvedSessionKey, event);

          const attachmentSummary = describeClawlineAttachments(attachments);
          const inboundBody = attachmentSummary
            ? `${rawContent}\n\n${attachmentSummary}`
            : rawContent;
          const inboundImages = await clawlineAttachmentsToImages(attachments, {
            loadAssetImage: loadInboundAssetImage,
          });

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
          const groupSystemPrompt = adapterOverrides.systemPrompt?.trim() || undefined;
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
            NativeChannelId: deliveryTarget.toString(),
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
          const prefixContext: ClawlineResponsePrefixContext = {
            identityName: resolveIdentityName(route.agentId),
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
              const deliverStartedAt = Date.now();
              logger.info?.("[clawline] agent_run_phase", {
                phase: "deliver_start",
                messageId: clientId,
                sessionKey: resolvedSessionKey,
                hasText: Boolean(replyPayload.text?.trim()),
                mediaUrlCount: replyPayload.mediaUrls?.length ?? (replyPayload.mediaUrl ? 1 : 0),
                sourceMessageId,
                interactiveAction: action,
              });
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
              if (markMessageFailedIfDeviceRevoked(session.deviceId, clientId)) {
                return;
              }
              const assistantEvent = await persistAssistantMessage(
                session,
                targetUserId,
                assistantText,
                route.sessionKey,
                replyAttachments,
                {
                  replyToMessageId: event.id,
                  replyToClientMessageId: clientId,
                },
              );
              broadcastToSessionKey(resolvedSessionKey, assistantEvent);
              await broadcastStreamTailStateForUser(targetUserId, assistantEvent);
              logger.info?.("[clawline] agent_run_phase", {
                phase: "deliver_done",
                messageId: clientId,
                sessionKey: resolvedSessionKey,
                assistantTextLength: assistantText.length,
                attachmentCount: replyAttachments.length,
                elapsedMs: Date.now() - deliverStartedAt,
                sourceMessageId,
                interactiveAction: action,
              });
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

          runAgentDispatch = async () => {
            logger.info?.("[clawline] agent_run_start", {
              messageId: clientId,
              sessionId: session.sessionId,
              sessionKey: resolvedSessionKey,
              userId: session.userId,
              deviceId: session.deviceId,
              sourceMessageId,
              interactiveAction: action,
            });
            const activeRun: SessionStatusActiveRun = {
              runId: event.id,
              messageId: clientId,
              sessionKey: resolvedSessionKey,
              startedAt: Date.now(),
              provider: null,
              model: null,
              thinkingLevel: null,
              fastMode: null,
            };
            activeSessionRuns.set(normalizeSessionKey(resolvedSessionKey), activeRun);

            let queuedFinal = false;
            let deliveredCount = 0;
            const dispatchStartedAt = Date.now();
            try {
              logger.info?.("[clawline] agent_run_phase", {
                phase: "dispatch_start",
                messageId: clientId,
                sessionKey: resolvedSessionKey,
                imageCount: inboundImages.length,
                sourceMessageId,
                interactiveAction: action,
              });
              const result = await runWithClawlineOutboundCorrelation(
                {
                  replyToMessageId: event.id,
                  replyToClientMessageId: clientId,
                },
                () =>
                  dispatchInboundMessage({
                    ctx: ctxPayload,
                    cfg: openClawCfg,
                    dispatcher,
                    replyOptions: {
                      ...replyOptions,
                      images: inboundImages.length > 0 ? inboundImages : undefined,
                      onModelSelected: (ctx) => {
                        prefixContext.provider = ctx.provider;
                        prefixContext.model = extractClawlineShortModelName(ctx.model);
                        prefixContext.modelFull = `${ctx.provider}/${ctx.model}`;
                        prefixContext.thinkingLevel = ctx.thinkLevel ?? "off";
                        prefixContext.fastMode = ctx.fastMode;
                        activeRun.provider = ctx.provider;
                        activeRun.model = ctx.model;
                        activeRun.thinkingLevel = ctx.thinkLevel ?? "off";
                        activeRun.fastMode = ctx.fastMode ?? null;
                        rememberSessionRuntimeStatus(resolvedSessionKey, {
                          provider: ctx.provider,
                          model: ctx.model,
                          thinkingLevel: ctx.thinkLevel ?? "off",
                          fastMode: ctx.fastMode ?? null,
                        });
                      },
                    },
                    replyResolver: options.replyResolver,
                  }),
              );
              queuedFinal = result.queuedFinal;
              // Count all delivered content (streaming blocks, tool results, and final replies)
              deliveredCount = result.counts.block + result.counts.tool + result.counts.final;
              logger.info?.("[clawline] agent_run_phase", {
                phase: "dispatch_return",
                messageId: clientId,
                sessionKey: resolvedSessionKey,
                queuedFinal,
                deliveredCount,
                blockCount: result.counts.block,
                toolCount: result.counts.tool,
                finalCount: result.counts.final,
                elapsedMs: Date.now() - dispatchStartedAt,
                sourceMessageId,
                interactiveAction: action,
              });
            } catch (err) {
              logger.error?.(`[clawline] dispatch_failed: ${formatError(err)}`);
              queuedFinal = false;
            }
            const waitForIdleStartedAt = Date.now();
            logger.info?.("[clawline] agent_run_phase", {
              phase: "wait_for_idle_start",
              messageId: clientId,
              sessionKey: resolvedSessionKey,
              sourceMessageId,
              interactiveAction: action,
            });
            markDispatchIdle();
            await dispatcher.waitForIdle();
            logger.info?.("[clawline] agent_run_phase", {
              phase: "wait_for_idle_done",
              messageId: clientId,
              sessionKey: resolvedSessionKey,
              elapsedMs: Date.now() - waitForIdleStartedAt,
              sourceMessageId,
              interactiveAction: action,
            });

            // Always send activity=false when done
            if (activitySignaled) {
              activitySignaled = false;
              void sendActivitySignal(false);
            }
            if (markMessageFailedIfDeviceRevoked(session.deviceId, clientId)) {
              return;
            }

            const queueKey = route.sessionKey;
            const queueDepth = getClawlineFollowupQueueDepth(queueKey);
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
              activeSessionRuns.delete(normalizeSessionKey(resolvedSessionKey));
              return;
            }

            updateMessageStreamingStmt.run(
              wasQueued ? MessageStreamingState.Queued : MessageStreamingState.Finalized,
              session.deviceId,
              clientId,
            );
            activeSessionRuns.delete(normalizeSessionKey(resolvedSessionKey));
          };
          await runAgentDispatch();
          runAgentDispatch = null;
        },
        { streamKey: resolvedSessionKey },
      );
      const dispatchAgentRun = runAgentDispatch as (() => Promise<void>) | null;
      if (!dispatchAgentRun) {
        return;
      }
      await dispatchAgentRun();
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
    | { kind: "session"; userId: string; sessionKey: string }
    | { kind: "device"; userId: string; deviceId: string };

  function resolveOwningUserIdForSessionKey(sessionKey: string): string {
    const normalized = normalizeSessionKey(sessionKey);
    if (!normalized) {
      return "";
    }
    const seenUserIds = new Set<string>();
    for (const entry of allowlist.entries) {
      const canonicalUserId = resolveUserTarget(entry.userId).userId;
      const dedupeKey = canonicalUserId.toLowerCase();
      if (seenUserIds.has(dedupeKey)) {
        continue;
      }
      seenUserIds.add(dedupeKey);
      if (loadStreamRowForUser(canonicalUserId, normalized)) {
        return canonicalUserId;
      }
    }
    return "";
  }

  async function resolveSessionTargetFromSessionKey(
    sessionKey: string,
  ): Promise<ResolvedSendTarget> {
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
      return {
        kind: "session",
        userId: resolveUserTarget(adminEntry.userId).userId,
        sessionKey: mainSessionKey,
      };
    }
    const parsed = parseClawlineUserSessionKey(trimmed);
    if (parsed) {
      const canonicalUserId = resolveUserTarget(parsed.userId).userId;
      return {
        kind: "session",
        userId: canonicalUserId,
        sessionKey: buildClawlineUserStreamSessionKey(
          parsed.agentId,
          canonicalUserId,
          parsed.streamSuffix,
        ),
      };
    }
    const owningUserId = resolveOwningUserIdForSessionKey(trimmed);
    if (!owningUserId) {
      throw new Error("Invalid clawline session key");
    }
    return {
      kind: "session",
      userId: owningUserId,
      sessionKey: trimmed,
    };
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
      let payload: unknown;
      try {
        payload = JSON.parse(rawString);
      } catch {
        await sendJson(ws, { type: "error", code: "invalid_message", message: "Malformed JSON" });
        ws.close();
        return;
      }
      if (!isClientPayload(payload) || typeof payload.type !== "string") {
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
        case "stream_read":
          await handleAuthedStreamRead(ws, payload);
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
      } catch (err) {
        logger.warn?.("[clawline:terminal] terminal_pty_kill_failed", {
          terminalSessionId: state.terminalSessionId,
          tmuxSessionName: state.tmuxSessionName,
          error: formatError(err),
        });
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
        if ("authInProgress" in state && state.authInProgress) {
          return;
        }
        void sendJson(ws, { type: "terminal_error", message: "Expected terminal_auth" });
        ws.close();
        return;
      }
      const rawString = rawDataToString(raw);
      let payload: unknown;
      try {
        payload = JSON.parse(rawString);
      } catch {
        void sendJson(ws, { type: "terminal_error", message: "Malformed JSON" });
        ws.close();
        return;
      }
      if (
        "authInProgress" in state &&
        state.authInProgress &&
        (!isClientPayload(payload) || payload.type !== "terminal_auth")
      ) {
        return;
      }
      if (!isClientPayload(payload) || payload.type !== "terminal_auth") {
        void sendJson(ws, { type: "terminal_error", message: "Expected terminal_auth" });
        ws.close();
        return;
      }
      if ("authInProgress" in state && state.authInProgress) {
        return;
      }
      terminalConnectionState.set(ws, { authenticated: false, authInProgress: true });
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
      try {
        state.pty.write(buf.toString("utf8"));
      } catch (err) {
        logger.warn?.("[clawline:terminal] terminal_input_write_failed", {
          terminalSessionId: state.terminalSessionId,
          tmuxSessionName: state.tmuxSessionName,
          error: formatError(err),
        });
        await sendJson(ws, { type: "terminal_error", message: "Failed to write terminal input" });
        ws.close();
      }
      return;
    }

    const rawString = rawDataToString(raw);
    let payload: unknown;
    try {
      payload = JSON.parse(rawString);
    } catch {
      await sendJson(ws, { type: "terminal_error", message: "Malformed JSON" });
      ws.close();
      return;
    }
    if (!isClientPayload(payload) || typeof payload.type !== "string") {
      await sendJson(ws, { type: "terminal_error", message: "Missing type" });
      ws.close();
      return;
    }
    switch (payload.type) {
      case "terminal_resize": {
        const cols = typeof payload.cols === "number" ? Math.floor(payload.cols) : 0;
        const rows = typeof payload.rows === "number" ? Math.floor(payload.rows) : 0;
        if (cols > 0 && rows > 0) {
          try {
            state.pty.resize(cols, rows);
          } catch (err) {
            logger.warn?.("[clawline:terminal] terminal_resize_failed", {
              terminalSessionId: state.terminalSessionId,
              tmuxSessionName: state.tmuxSessionName,
              cols,
              rows,
              error: formatError(err),
            });
            await sendJson(ws, { type: "terminal_error", message: "Failed to resize terminal" });
            ws.close();
            return;
          }
          void resizeTmuxPane(state.paneId, cols, rows, state.tmuxBackend);
        } else {
          await sendJson(ws, { type: "terminal_error", message: "Invalid terminal resize" });
          ws.close();
        }
        break;
      }
      case "terminal_detach": {
        try {
          state.pty.kill();
        } catch (err) {
          logger.warn?.("[clawline:terminal] terminal_detach_kill_failed", {
            terminalSessionId: state.terminalSessionId,
            tmuxSessionName: state.tmuxSessionName,
            error: formatError(err),
          });
          await sendJson(ws, { type: "terminal_error", message: "Failed to detach terminal" });
          ws.close();
          return;
        }
        void sendJson(ws, { type: "terminal_closed" });
        ws.close();
        break;
      }
      case "terminal_close": {
        void killTmuxSession(state.tmuxSessionName, state.tmuxBackend);
        try {
          state.pty.kill();
        } catch (err) {
          logger.warn?.("[clawline:terminal] terminal_close_kill_failed", {
            terminalSessionId: state.terminalSessionId,
            tmuxSessionName: state.tmuxSessionName,
            error: formatError(err),
          });
          await sendJson(ws, { type: "terminal_error", message: "Failed to close terminal" });
          ws.close();
          return;
        }
        void sendJson(ws, { type: "terminal_closed" });
        ws.close();
        break;
      }
      default:
        await sendJson(ws, { type: "terminal_error", message: "Unknown terminal message type" });
        ws.close();
        break;
    }
  }

  async function handleTerminalAuth(ws: WebSocket, payload: ClientPayload) {
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
        destination: dbRecord.destination,
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
    const tmuxBackend = createTerminalTmuxBackend(
      config,
      logger,
      record.destination?.address ?? null,
    );

    try {
      logger.info?.("[clawline:terminal] terminal_auth_start", {
        terminalSessionId,
        tmuxSessionName: record.tmuxSessionName,
        userId: entry.userId,
        deviceId,
        cols,
        rows,
        backfillLines,
      });
      let paneId = await resolveTmuxPaneId(record.tmuxSessionName, tmuxBackend);
      if (!paneId) {
        // If the session was referenced by a bubble but the tmux session hasn't been created yet,
        // create it on-demand so auth succeeds.
        const ensured = await ensureTmuxSessionExists(record.tmuxSessionName, tmuxBackend);
        if (ensured) {
          paneId = await resolveTmuxPaneId(record.tmuxSessionName, tmuxBackend);
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
        const backfill = await captureTmuxBackfill(
          paneId,
          Math.min(backfillLines, 5000),
          tmuxBackend,
        );
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
        tmuxBackend,
        pty,
      });
      logger.info?.("[clawline:terminal] terminal_auth_ready", {
        terminalSessionId,
        tmuxSessionName: record.tmuxSessionName,
        paneId,
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
    } catch (err) {
      logger.warn?.("[clawline:terminal] terminal_auth_attach_failed", {
        terminalSessionId,
        tmuxSessionName: record.tmuxSessionName,
        error: formatError(err),
      });
      await sendJson(ws, { type: "terminal_error", message: "Failed to attach terminal" });
      try {
        ws.close();
      } catch {
        // ignore
      }
      terminalConnectionState.delete(ws);
    }
  }

  async function resolveTmuxPaneId(
    tmuxSessionName: string,
    tmuxBackend: TerminalTmuxBackend,
  ): Promise<string | null> {
    try {
      const { stdout } = await tmuxBackend.execTmux(
        ["list-panes", "-t", tmuxSessionName, "-F", "#{pane_id}"],
        { timeout: 2_000, maxBuffer: 1024 * 1024 },
      );
      const paneId = String(stdout).trim().split(/\s+/)[0];
      return paneId ? paneId : null;
    } catch (err) {
      logger.warn?.("[clawline:terminal] tmux_resolve_pane_failed", {
        tmuxSessionName,
        error: formatError(err),
      });
      return null;
    }
  }

  async function captureTmuxBackfill(
    paneId: string,
    backfillLines: number,
    tmuxBackend: TerminalTmuxBackend,
  ): Promise<Buffer> {
    if (backfillLines <= 0) {
      return Buffer.alloc(0);
    }
    try {
      const { stdout } = await tmuxBackend.execTmux(
        ["capture-pane", "-p", "-e", "-t", paneId, "-S", `-${backfillLines}`],
        { timeout: 3_000, maxBuffer: 10 * 1024 * 1024 },
      );
      return Buffer.from(String(stdout), "utf8");
    } catch (err) {
      logger.warn?.("[clawline:terminal] tmux_capture_backfill_failed", {
        paneId,
        backfillLines,
        error: formatError(err),
      });
      return Buffer.alloc(0);
    }
  }

  async function ensureTmuxSessionExists(
    tmuxSessionName: string,
    tmuxBackend: TerminalTmuxBackend,
  ): Promise<boolean> {
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
      // Pass an explicit shell sentinel command so the pane stays alive in
      // headless / daemon environments where the default shell may exit
      // immediately before resolveTmuxPaneId can query the pane.  The shell
      // itself is the persistent foreground process; when the user attaches
      // they land in an interactive shell rather than a dead pane.
      const shell = process.env.SHELL?.trim() || "/bin/sh";
      await tmuxBackend.execTmux(["new-session", "-d", "-s", name, shell], {
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

  async function resizeTmuxPane(
    paneId: string,
    cols: number,
    rows: number,
    tmuxBackend: TerminalTmuxBackend,
  ) {
    try {
      await tmuxBackend.execTmux(
        ["resize-pane", "-t", paneId, "-x", String(cols), "-y", String(rows)],
        { timeout: 2_000, maxBuffer: 1024 * 1024 },
      );
    } catch (err) {
      logger.warn?.("[clawline:terminal] tmux_resize_pane_failed", {
        paneId,
        cols,
        rows,
        error: formatError(err),
      });
    }
  }

  async function killTmuxSession(tmuxSessionName: string, tmuxBackend: TerminalTmuxBackend) {
    try {
      await tmuxBackend.execTmux(["kill-session", "-t", tmuxSessionName], {
        timeout: 2_000,
        maxBuffer: 1024 * 1024,
      });
    } catch (err) {
      logger.warn?.("[clawline:terminal] tmux_kill_session_failed", {
        tmuxSessionName,
        error: formatError(err),
      });
    }
  }

  async function handlePairRequest(ws: WebSocket, payload: ClientPayload) {
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
    const sanitizedClaimedName = sanitizeLabel(
      typeof payload.claimedName === "string" ? payload.claimedName : undefined,
    )?.toLowerCase();
    const normalizedUserId = normalizeUserIdFromClaimedName(sanitizedClaimedName);
    const deviceId = payload.deviceId;
    await refreshAllowlistFromDisk();
    const entry = findAllowlistEntry(deviceId);
    if (entry) {
      logger.info?.(
        `[clawline:http] pair_request_allowlist_entry ${describePairingEntry(entry)} userId=${entry.userId} isAdmin=${entry.isAdmin} tokenDelivered=${entry.tokenDelivered} lastSeenAt=${entry.lastSeenAt ?? "null"}`,
      );
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
      }
      logger.info?.("[clawline:http] pair_request_token_redispatch", { deviceId });
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
    logger.info?.(
      `[clawline:http] pair_request_upsert_pending ${describePairingEntry(pendingEntry)} pendingCount=${pendingFile.entries.length + (existingPendingEntry ? 0 : 1)}`,
    );
    await upsertPendingEntry(pendingEntry);
    logger.info?.(
      `[clawline:http] pair_request_pending_persisted ${describePairingEntry(pendingEntry)} pendingEntries=${pendingFile.entries.length}`,
    );
    notifyGatewayOfPending(pendingEntry)
      .then(() =>
        logger.info?.(
          `[clawline:http] pair_request_pending_notified ${describePairingEntry(pendingEntry)}`,
        ),
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

  async function handleAuth(ws: WebSocket, payload: ClientPayload) {
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
    const clientAdoptedSessionKeys = entry.isAdmin ? parseAdoptedSessionKeys(payload) : [];
    const storedAdoptedSessionKeys = entry.isAdmin
      ? readAdoptedSessionKeysForUser(entry.userId)
      : [];
    const adoptedSessionKeys = dedupeKeys([
      ...storedAdoptedSessionKeys,
      ...clientAdoptedSessionKeys,
    ]);
    let resolveReplayBarrier!: () => void;
    const replayBarrier = new Promise<void>((resolve) => {
      resolveReplayBarrier = resolve;
    });
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
      adoptedSessionKeys: [],
      personalSessionKey: "",
      dmScope: "main",
      dmSessionKey: "",
      globalSessionKey: "",
      peerId,
      claimedName: entry.claimedName,
      deviceInfo: entry.deviceInfo,
      replayInProgress: true,
      replayDeliveredMessageIds: new Set(),
      replayBufferedMessages: [],
      replayBarrier,
      resolveReplayBarrier,
      revoked: false,
    };
    applySessionInfo(session, entry.isAdmin, adoptedSessionKeys);
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
      const replayCursorsBySessionKey =
        payload.replayCursorsBySessionKey &&
        typeof payload.replayCursorsBySessionKey === "object" &&
        !Array.isArray(payload.replayCursorsBySessionKey)
          ? (payload.replayCursorsBySessionKey as Record<string, unknown>)
          : {};
      if (typeof payload.lastMessageId === "string") {
        logger.warn?.("[clawline] deprecated_replay_auth_field", {
          deviceId: session.deviceId,
          userId: session.userId,
          deprecatedField: "lastMessageId",
          replacementField: "replayCursorsBySessionKey",
          lastMessageIdPresent: true,
        });
      }
      logger.info("replay_request", {
        deviceId: session.deviceId,
        userId: session.userId,
        lastMessageId: lastMessageId ?? "(null)",
        replayCursorCount: Object.keys(replayCursorsBySessionKey).length,
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
        session.replayInProgress = false;
        session.resolveReplayBarrier();
        ws.close();
        return;
      }
      await sendReplay(session, lastMessageId, replayCursorsBySessionKey);
    } catch {
      session.replayInProgress = false;
      session.resolveReplayBarrier();
      removeSession(session);
      connectionState.delete(ws);
      await sendJson(ws, { type: "error", code: "server_error", message: "Replay failed" }).catch(
        () => {},
      );
      ws.close(1011);
      return;
    }
  }

  async function handleAuthedMessage(ws: WebSocket, payload: ClientPayload) {
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
    if (session.replayInProgress) {
      await session.replayBarrier;
    }
    if (sessionsByDevice.get(session.deviceId) !== session || session.revoked) {
      return;
    }
    await processClientMessage(session, payload);
  }

  async function handleAuthedStreamRead(ws: WebSocket, payload: ClientPayload) {
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
    const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey.trim() : "";
    const lastReadMessageId =
      typeof payload.lastReadMessageId === "string" ? payload.lastReadMessageId.trim() : "";
    if (!sessionKey || !lastReadMessageId || !SERVER_EVENT_ID_REGEX.test(lastReadMessageId)) {
      await sendJson(ws, {
        type: "error",
        code: "invalid_message",
        message: "Invalid stream read payload",
      }).catch(() => {});
      return;
    }
    const normalizedSessionKey = normalizeSessionKey(sessionKey);
    const allowedSessionKey = session.sessionKeys.find((candidate) =>
      sessionKeyEq(candidate, normalizedSessionKey),
    );
    if (!allowedSessionKey) {
      await sendJson(ws, {
        type: "error",
        code: "stream_not_found",
        message: "Stream not found",
      }).catch(() => {});
      return;
    }
    try {
      const update = await runPerUserTask(session.userId, async () =>
        enqueueWriteTask(() =>
          updateStreamReadState({
            userId: session.userId,
            sessionKey: allowedSessionKey,
            lastReadMessageId,
          }),
        ),
      );
      if (!update.updated) {
        return;
      }
      await broadcastStreamEvent(session.userId, {
        type: "stream_read_state",
        sessionKey: update.sessionKey,
        lastReadMessageId: update.lastReadMessageId,
      });
    } catch (error) {
      if (error instanceof ClientMessageError) {
        await sendJson(ws, {
          type: "error",
          code: error.code,
          message: error.message,
        }).catch(() => {});
        return;
      }
      throw error;
    }
  }

  async function handleAuthedInteractiveCallback(ws: WebSocket, payload: ClientPayload) {
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
    if (session.replayInProgress) {
      await session.replayBarrier;
    }
    if (sessionsByDevice.get(session.deviceId) !== session || session.revoked) {
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
        if (!assetCleanupInterval && config.media.unreferencedUploadTtlSeconds > 0) {
          assetCleanupInterval = setInterval(() => {
            cleanupUnreferencedAssets().catch((err) =>
              logger.warn?.(`asset_cleanup_failed: ${formatError(err)}`),
            );
          }, maintenanceIntervalMs);
          if (typeof assetCleanupInterval.unref === "function") {
            assetCleanupInterval.unref();
          }
        }
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
      const protocol = providerTls.enabled ? "wss" : "ws";
      logger.info(`Provider listening on ${protocol}://${config.network.bindAddress}:${port}`);
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
