import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import WebSocket, { WebSocketServer } from "ws";
import jwt from "jsonwebtoken";
import BetterSqlite3 from "better-sqlite3";
import type { Database as SqliteDatabase, Statement as SqliteStatement } from "better-sqlite3";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { dispatchReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import { extractShortModelName } from "../auto-reply/reply/response-prefix-template.js";
import type { ResponsePrefixContext } from "../auto-reply/reply/response-prefix-template.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import {
  resolveAgentRoute,
  buildAgentSessionKey,
  DEFAULT_ACCOUNT_ID,
} from "../routing/resolve-route.js";
import {
  resolveEffectiveMessagesConfig,
  resolveHumanDelayConfig,
  resolveIdentityName,
} from "../agents/identity.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  updateLastRoute,
} from "../config/sessions.js";
import { rawDataToString } from "../infra/ws.js";
import { recordClawlineSessionActivity } from "./session-store.js";
import type { ClawlineAdapterOverrides } from "./config.js";
import { buildClawlineSessionKey, clawlineSessionFileName } from "./session-key.js";
import { deepMerge } from "./utils/deep-merge.js";
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
  ClawlineOutboundSendParams,
  ClawlineOutboundSendResult,
} from "./domain.js";
import { ClientMessageError, HttpError } from "./errors.js";
import { SlidingWindowRateLimiter } from "./rate-limiter.js";
import { createAssetHandlers } from "./http-assets.js";
import { callGateway } from "../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../gateway/protocol/client-info.js";

export const PROTOCOL_VERSION = 1;

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
const MAX_ATTACHMENTS_COUNT = 4;
// Hard ceiling for a single client payload: 64 KB text budget + 256 KB inline assets + JSON overhead.
const MAX_TOTAL_PAYLOAD_BYTES = 320 * 1024;
const MAX_ALERT_BODY_BYTES = 4 * 1024;
type ChannelType = "personal" | "admin";
const DEFAULT_CHANNEL_TYPE: ChannelType = "personal";
const ADMIN_CHANNEL_TYPE: ChannelType = "admin";
const DEFAULT_ALERT_SOURCE = "notify";
const ADMIN_USER_ID = "flynn";
const USER_ID_MAX_LENGTH = 48;
const COMBINING_MARKS_REGEX = /[\u0300-\u036f]/g;

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
  if (!claimedName) return null;
  const ascii = claimedName.normalize("NFKD").replace(COMBINING_MARKS_REGEX, "");
  const lowered = ascii.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9]+/g, "_");
  const trimmed = replaced.replace(/^_+|_+$/g, "");
  if (!trimmed) return null;
  return trimmed.slice(0, USER_ID_MAX_LENGTH);
}

function sanitizeUserId(userId: string | undefined): string {
  return (userId ?? "").trim();
}

function isAdminUserId(userId: string): boolean {
  return sanitizeUserId(userId).toLowerCase() === ADMIN_USER_ID;
}

function applyIdentityPolicy(entry: AllowlistEntry) {
  const normalizedFromName = normalizeUserIdFromClaimedName(entry.claimedName);
  let nextUserId = normalizedFromName ?? sanitizeUserId(entry.userId);
  if (!nextUserId) {
    nextUserId = generateUserId();
  }
  entry.userId = nextUserId;
  entry.isAdmin = isAdminUserId(entry.userId);
}

async function notifyGatewayOfPending(entry: PendingEntry) {
  const name = entry.claimedName ?? "New device";
  const platform = entry.deviceInfo.platform || "Unknown platform";
  const text = `New device pending approval: ${name} (${platform})`;
  try {
    await callGateway({
      method: "wake",
      params: { text, mode: "now" },
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      clientDisplayName: "clawline",
      clientVersion: "clawline",
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
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
  if (raw.length > MAX_ATTACHMENTS_COUNT) {
    throw new ClientMessageError("payload_too_large", "Too many attachments");
  }
  let inlineBytes = 0;
  const attachments: NormalizedAttachment[] = [];
  const assetIds: string[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      throw new ClientMessageError("invalid_message", "Invalid attachment");
    }
    const typed = entry as any;
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
      if (decoded.length > mediaConfig.maxInlineBytes) {
        throw new ClientMessageError("payload_too_large", "Inline attachment too large");
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
    throw new ClientMessageError("payload_too_large", "Inline attachments exceed limit");
  }
  return { attachments, inlineBytes, assetIds };
}

function normalizeChannelType(value: unknown): ChannelType {
  if (typeof value === "string" && value.trim().toLowerCase() === ADMIN_CHANNEL_TYPE) {
    return ADMIN_CHANNEL_TYPE;
  }
  return DEFAULT_CHANNEL_TYPE;
}

function describeClawlineAttachments(
  attachments: NormalizedAttachment[],
  assetsDir: string,
): string | null {
  if (attachments.length === 0) {
    return null;
  }
  const lines = attachments.map((attachment, index) => {
    const label = `Attachment ${index + 1}`;
    if (attachment.type === "asset") {
      const assetPath = path.join(assetsDir, attachment.assetId);
      return `${label}: uploaded asset ${attachment.assetId} at ${assetPath}`;
    }
    const approxBytes = Math.round((attachment.data.length / 4) * 3);
    return `${label}: inline image (${attachment.mimeType}, ~${approxBytes} bytes)`;
  });
  return `Attachments:\n${lines.join("\n")}`;
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
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function validateDeviceInfo(value: any): value is DeviceInfo {
  if (!value || typeof value !== "object") {
    return false;
  }
  const requiredString = (input: unknown) =>
    typeof input === "string" && input.length > 0 && Buffer.byteLength(input, "utf8") <= 64;
  if (!requiredString(value.platform) || !requiredString(value.model)) {
    return false;
  }
  if (value.osVersion !== undefined && !requiredString(value.osVersion) && value.osVersion !== "") {
    return false;
  }
  if (
    value.appVersion !== undefined &&
    !requiredString(value.appVersion) &&
    value.appVersion !== ""
  ) {
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
  sessionId: string;
  sessionKey: string;
  peerId: string;
  claimedName?: string;
  deviceInfo?: DeviceInfo;
};

type ConnectionState = {
  authenticated: boolean;
  deviceId?: string;
  userId?: string;
  sessionId?: string;
};

type ServerMessage = {
  type: "message";
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  streaming: boolean;
  attachments?: unknown[];
  deviceId?: string;
  channelType?: ChannelType;
};

enum MessageStreamingState {
  Finalized = 0,
  Active = 1,
  Failed = 2,
}

export const DEFAULT_ALERT_INSTRUCTIONS_TEXT = `After handling this alert, evaluate: would Flynn want to know what happened? If yes, report to him. Don't just process silently.`;

const DEFAULT_CONFIG: ProviderConfig = {
  port: 18800,
  statePath: path.join(os.homedir(), ".clawdbot", "clawline"),
  alertInstructionsPath: path.join(os.homedir(), ".clawdbot", "clawline", "alert-instructions.md"),
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
    storagePath: path.join(os.homedir(), ".clawdbot", "clawline-media"),
    maxInlineBytes: 262_144,
    maxUploadBytes: 104_857_600,
    unreferencedUploadTtlSeconds: 3600,
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
  },
};

const ALLOWLIST_FILENAME = "allowlist.json";
const PENDING_FILENAME = "pending.json";
const DENYLIST_FILENAME = "denylist.json";
const JWT_KEY_FILENAME = "jwt.key";
const DB_FILENAME = "clawline.sqlite";
const SESSION_REPLACED_CODE = 1000;

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
  } catch (err: any) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
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
      throw new Error("JWT signing key must be at least 32 bytes (64 hex characters)");
    }
    return trimmed;
  };
  if (provided) {
    return validateKey(provided);
  }
  try {
    const data = await fs.readFile(filePath, "utf8");
    return validateKey(data);
  } catch (err: any) {
    if (err && err.code !== "ENOENT") {
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
  const parts = attachments.map((attachment) =>
    attachment.type === "image"
      ? `{"type":"image","mimeType":${quote(attachment.mimeType)},"data":${quote(attachment.data)}}`
      : `{"type":"asset","assetId":${quote(attachment.assetId)}}`,
  );
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

function parseServerMessage(json: string): ServerMessage {
  return JSON.parse(json) as ServerMessage;
}

export async function createProviderServer(options: ProviderOptions): Promise<ProviderServer> {
  const config = mergeConfig(options.config);
  const adapterOverrides =
    (options.config as { adapterOverrides?: ClawlineAdapterOverrides } | undefined)
      ?.adapterOverrides ?? {};
  const clawdbotCfg = options.clawdbotConfig;
  const logger: Logger = options.logger ?? console;
  const sessionStorePath = options.sessionStorePath;
  const mainSessionKey = options.mainSessionKey?.trim() || "agent:main:main";
  const mainSessionAgentId = resolveAgentIdFromSessionKey(mainSessionKey);
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
  const assetsDir = path.join(config.media.storagePath, "assets");
  const tmpDir = path.join(config.media.storagePath, "tmp");
  await ensureDir(assetsDir);
  await ensureDir(tmpDir);
  await ensureDir(sessionTranscriptsDir);
  if (alertInstructionsPath) {
    await ensureAlertInstructionsFileIfMissing();
  }

  const allowlistPath = path.join(config.statePath, ALLOWLIST_FILENAME);
  const pendingPath = path.join(config.statePath, PENDING_FILENAME);
  const denylistPath = path.join(config.statePath, DENYLIST_FILENAME);
  const jwtKeyPath = path.join(config.statePath, JWT_KEY_FILENAME);
  const dbPath = path.join(config.statePath, DB_FILENAME);

  let allowlist = await loadAllowlist(allowlistPath);
  allowlist.entries.forEach(applyIdentityPolicy);
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
  let selectEventsAfterTimestampStmt!: SqliteStatement;
  let insertUserMessageTx!: ReturnType<SqliteDatabase["transaction"]>;
  let insertEventTx!: ReturnType<SqliteDatabase["transaction"]>;
  let handleUpload!: AssetHandlers["handleUpload"];
  let handleDownload!: AssetHandlers["handleDownload"];
  let cleanupTmpDirectory!: AssetHandlers["cleanupTmpDirectory"];
  let cleanupOrphanedAssetFiles!: AssetHandlers["cleanupOrphanedAssetFiles"];
  let cleanupUnreferencedAssets!: AssetHandlers["cleanupUnreferencedAssets"];

  function initializeDatabaseResources(): boolean {
    if (db) {
      return false;
    }
    const newDb = new BetterSqlite3(dbPath, { fileMustExist: false });
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
        timestamp INTEGER NOT NULL
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

    sequenceStatement = userSequenceStmt(newDb);
    insertEventStmt = newDb.prepare(
      `INSERT INTO events (id, userId, sequence, originatingDeviceId, payloadJson, payloadBytes, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
        auth.isAdmin === true || assetOwnerId === auth.userId,
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
        channelType: ChannelType,
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
          channelType,
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
      `SELECT id, payloadJson FROM events WHERE userId = ? AND sequence > ? ORDER BY sequence ASC`,
    );
    selectEventsTailStmt = newDb.prepare(
      `SELECT id, payloadJson FROM events WHERE userId = ? ORDER BY sequence DESC LIMIT ?`,
    );
    selectEventByIdStmt = newDb.prepare(
      `SELECT id, userId, sequence, timestamp FROM events WHERE id = ?`,
    );
    selectEventsAfterTimestampStmt = newDb.prepare(
      `SELECT id, payloadJson FROM events WHERE userId = ? AND timestamp > ? ORDER BY sequence ASC`,
    );
    insertEventTx = newDb.transaction(
      (event: ServerMessage, userId: string, originatingDeviceId?: string) => {
        const payloadJson = JSON.stringify(event);
        const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
        const sequenceRow = sequenceStatement.get(userId) as { sequence: number };
        insertEventStmt.run(
          event.id,
          userId,
          sequenceRow.sequence,
          originatingDeviceId ?? null,
          payloadJson,
          payloadBytes,
          event.timestamp,
        );
        return sequenceRow.sequence;
      },
    );

    db = newDb;
    return true;
  }

  function disposeDatabaseResources() {
    if (db) {
      db.close();
      db = null;
    }
  }

  if (initializeDatabaseResources()) {
    await cleanupTmpDirectory();
    await cleanupOrphanedAssetFiles();
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
        logger.warn?.("[clawline] inline_attachment_decode_failed", err);
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
        logger.warn?.("[clawline] inline_attachment_persist_failed", err);
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
    channelType: ChannelType;
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
        if (typeof headerValue === "string") return headerValue.toLowerCase().includes(needle);
        if (Array.isArray(headerValue))
          return headerValue.some((value) => value.toLowerCase().includes(needle));
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
      logger.error("http_request_failed", err);
      if (!res.headersSent) {
        sendHttpError(res, 500, "server_error", "Internal error");
      } else {
        res.end();
      }
    }
  });

  async function handleAlertHttpRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    logHttpRequest("alert_request_start");
    try {
      const payload = await parseAlertPayload(req);
      let text = buildAlertText(payload.message, payload.source);
      text = await applyAlertInstructions(text);
      await wakeGatewayForAlert(text);
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      logHttpRequest("alert_request_complete");
    } catch (err) {
      if (err instanceof HttpError) {
        logHttpRequest("alert_request_error", { status: err.status, code: err.code });
        sendHttpError(res, err.status, err.code, err.message);
      } else {
        logger.error("alert_request_failed", err);
        sendHttpError(res, 500, "server_error", "Internal error");
      }
    }
  }

  async function parseAlertPayload(
    req: http.IncomingMessage,
  ): Promise<{ message: string; source?: string }> {
    const raw = await readRequestBody(req, MAX_ALERT_BODY_BYTES);
    if (raw.length === 0) {
      throw new HttpError(400, "invalid_request", "Empty alert payload");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new HttpError(400, "invalid_json", "Alert payload must be valid JSON");
    }
    if (!parsed || typeof parsed !== "object") {
      throw new HttpError(400, "invalid_request", "Alert payload must be an object");
    }
    const message = typeof (parsed as any).message === "string" ? (parsed as any).message : "";
    const source = typeof (parsed as any).source === "string" ? (parsed as any).source : undefined;
    if (!message.trim()) {
      throw new HttpError(400, "invalid_message", "Alert message is required");
    }
    return { message, source };
  }

  async function readRequestBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
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
          req.destroy();
          reject(new HttpError(413, "payload_too_large", "Alert payload too large"));
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
    } catch (err: any) {
      if (err && err.code !== "ENOENT") {
        logger.warn?.("alert_instructions_read_failed", err);
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
    } catch (err: any) {
      if (err && err.code !== "ENOENT") {
        logger.warn?.("alert_instructions_access_failed", err);
        return;
      }
      try {
        await ensureDir(path.dirname(alertInstructionsPath));
        await fs.writeFile(
          `${alertInstructionsPath}`,
          `${DEFAULT_ALERT_INSTRUCTIONS_TEXT}\n`,
          "utf8",
        );
        logger.info?.("alert_instructions_initialized", { alertInstructionsPath });
      } catch (writeErr) {
        logger.warn?.("alert_instructions_write_failed", writeErr);
      }
    }
  }

  async function wakeGatewayForAlert(text: string) {
    try {
      await callGateway({
        method: "wake",
        params: { text, mode: "now" },
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        clientDisplayName: "clawline-alert",
        clientVersion: "clawline",
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      });
    } catch (err) {
      logger.error("alert_gateway_wake_failed", err);
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

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const origin = request.headers.origin ?? "null";
    logger.info?.("[clawline:http] ws_upgrade_received", {
      url: request.url,
      origin,
    });
    if (request.url !== "/ws") {
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
    wss.handleUpgrade(request, socket, head, (ws) => {
      logger.info?.("[clawline:http] ws_handle_upgrade_complete", { origin });
      wss.emit("connection", ws, request);
    });
  });

  const connectionState = new WeakMap<WebSocket, ConnectionState>();
  const pendingSockets = new Map<string, PendingConnection>();
  const sessionsByDevice = new Map<string, Session>();
  const userSessions = new Map<string, Set<Session>>();
  const perUserQueue = new Map<string, Promise<unknown>>();
  const pairRateLimiter = new SlidingWindowRateLimiter(config.pairing.maxRequestsPerMinute, 60_000);
  const authRateLimiter = new SlidingWindowRateLimiter(config.auth.maxAttemptsPerMinute, 60_000);
  const messageRateLimiter = new SlidingWindowRateLimiter(
    config.sessions.maxMessagesPerSecond,
    1_000,
  );
  let writeQueue: Promise<void> = Promise.resolve();
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
          cleanupUnreferencedAssets().catch((err) => logger.warn("asset_cleanup_failed", err));
        }, maintenanceIntervalMs)
      : null;
  if (assetCleanupInterval && typeof assetCleanupInterval.unref === "function") {
    assetCleanupInterval.unref();
  }
  const allowlistWatcher: FSWatcher = watch(allowlistPath, { persistent: false }, () => {
    void refreshAllowlistFromDisk();
  });
  allowlistWatcher.on("error", (err) => logger.warn?.("allowlist_watch_failed", err));
  const pendingFileWatcher: FSWatcher = watch(pendingPath, { persistent: false }, () => {
    void refreshPendingFile();
  });
  pendingFileWatcher.on("error", (err) => logger.warn?.("pending_watch_failed", err));
  const denylistWatcher: FSWatcher = watch(denylistPath, { persistent: false }, () => {
    void refreshDenylist();
  });
  denylistWatcher.on("error", (err) => logger.warn?.("denylist_watch_failed", err));

  function runPerUserTask<T>(userId: string, task: () => Promise<T>): Promise<T> {
    const previous = perUserQueue.get(userId) ?? Promise.resolve();
    const next = previous.then(task, task).finally(() => {
      if (perUserQueue.get(userId) === next) {
        perUserQueue.delete(userId);
      }
    });
    perUserQueue.set(userId, next);
    return next;
  }

  function enqueueWriteTask<T>(task: () => T | Promise<T>): Promise<T> {
    const run = () => Promise.resolve().then(task);
    const result = writeQueue.then(run, run);
    writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function persistAllowlist() {
    await fs.writeFile(allowlistPath, JSON.stringify(allowlist, null, 2));
    handleAllowlistChanged();
  }

  async function persistPendingFile() {
    await fs.writeFile(pendingPath, JSON.stringify(pendingFile, null, 2));
  }

  async function refreshAllowlistFromDisk() {
    try {
      allowlist = await loadAllowlist(allowlistPath);
      allowlist.entries.forEach(applyIdentityPolicy);
      handleAllowlistChanged();
    } catch (err) {
      logger.warn?.("allowlist_reload_failed", err);
    }
  }

  async function refreshPendingFile() {
    try {
      pendingFile = await loadPending(pendingPath);
      reconcilePendingSocketsWithFile();
    } catch (err) {
      logger.warn?.("pending_reload_failed", err);
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
      logger.warn("denylist_reload_failed", err);
    }
  }

  function findAllowlistEntry(deviceId: string) {
    return allowlist.entries.find((entry) => entry.deviceId === deviceId);
  }

  function deviceHasAdminAccess(deviceId: string): boolean {
    const entry = findAllowlistEntry(deviceId);
    return entry?.isAdmin === true;
  }

  function sessionHasAdminAccess(session: Session): boolean {
    return deviceHasAdminAccess(session.deviceId);
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
      if (!entry) continue;
      if (session.isAdmin !== entry.isAdmin) {
        session.isAdmin = entry.isAdmin;
        const state = connectionState.get(session.socket);
        if (state && state.authenticated) {
          state.isAdmin = entry.isAdmin;
        }
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
    if (!pending) return;
    pendingSockets.delete(entry.deviceId);
    const token = issueToken(entry);
    const delivered = await sendJson(pending.socket, {
      type: "pair_result",
      success: true,
      token,
      userId: entry.userId,
    })
      .then(() => true)
      .catch(() => false);
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
    if (config.auth.tokenTtlSeconds) {
      payload.exp = payload.iat! + config.auth.tokenTtlSeconds;
    }
    const token = jwt.sign(payload, jwtKey, { algorithm: "HS256" });
    return token;
  }

  async function setTokenDelivered(deviceId: string, delivered: boolean) {
    const entry = findAllowlistEntry(deviceId);
    if (!entry) return;
    entry.tokenDelivered = delivered;
    await persistAllowlist();
  }

  async function updateLastSeen(deviceId: string, timestamp: number) {
    const entry = findAllowlistEntry(deviceId);
    if (!entry) return;
    entry.lastSeenAt = timestamp;
    await persistAllowlist();
  }

  function sendJson(ws: WebSocket, payload: unknown): Promise<void> {
    return new Promise((resolve) => {
      if (ws.readyState !== WebSocket.OPEN) {
        logger.warn?.("[clawline:http] send_json_socket_not_open");
        resolve();
        return;
      }
      ws.send(JSON.stringify(payload), (err) => {
        if (err) {
          logger.warn?.("[clawline:http] send_json_failed", err);
        }
        resolve();
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
    if (typeof decoded.exp === "number" && decoded.exp * 1000 < Date.now()) {
      throw new HttpError(401, "auth_failed", "Token expired");
    }
    return { deviceId, userId: entry.userId, isAdmin: entry.isAdmin };
  }

  async function safeUnlink(filePath: string) {
    try {
      await fs.unlink(filePath);
    } catch (err: any) {
      if (!err || err.code === "ENOENT") {
        return;
      }
      logger.warn("file_unlink_failed", err);
    }
  }

  async function sendReplay(session: Session, lastMessageId: string | null) {
    // All messages (both personal and DM channel) are stored under the real userId.
    // Query once to get all messages for this user.
    const transcriptTargets: Array<{ userId: string; channelType: ChannelType }> = [
      { userId: session.userId, channelType: DEFAULT_CHANNEL_TYPE },
    ];
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
        .map((row) => parseServerMessage(row.payloadJson))
        .map((event) => {
          if (!event.channelType) {
            event.channelType = target.channelType;
          }
          return event;
        });
      combined.push(...parsed);
    }
    combined.sort((a, b) => a.timestamp - b.timestamp);
    const limited =
      combined.length > config.sessions.maxReplayMessages
        ? combined.slice(combined.length - config.sessions.maxReplayMessages)
        : combined;
    const payload = {
      type: "auth_result",
      success: true,
      userId: session.userId,
      sessionId: session.sessionId,
      isAdmin: session.isAdmin,
      replayCount: limited.length,
      replayTruncated: combined.length > limited.length,
      historyReset: lastMessageId ? false : true,
    };
    // Debug logging for duplicate investigation
    logger.info("replay_complete", {
      deviceId: session.deviceId,
      replayCount: limited.length,
      historyReset: payload.historyReset,
      firstEventId: limited[0]?.id,
      lastEventId: limited[limited.length - 1]?.id,
    });
    await sendJson(session.socket, payload);
    for (const event of limited) {
      if (!event.channelType) {
        event.channelType = DEFAULT_CHANNEL_TYPE;
      }
      await sendJson(session.socket, event);
    }
  }

  function sendPayloadToSession(session: Session, payload: ServerMessage) {
    if (payload.channelType === ADMIN_CHANNEL_TYPE && !session.isAdmin) {
      return;
    }
    if (session.socket.readyState !== WebSocket.OPEN) return;
    session.socket.send(JSON.stringify(payload), (err) => {
      if (err) {
        session.socket.close();
      }
    });
  }

  function broadcastToUser(userId: string, payload: ServerMessage) {
    const sessions = userSessions.get(userId);
    if (!sessions) return;
    for (const session of sessions) {
      sendPayloadToSession(session, payload);
    }
  }

  function broadcastToAdmins(payload: ServerMessage) {
    for (const session of sessionsByDevice.values()) {
      if (!session.isAdmin) continue;
      sendPayloadToSession(session, payload);
    }
  }

  function deliverToDevice(deviceId: string, payload: ServerMessage): boolean {
    const session = sessionsByDevice.get(deviceId);
    if (!session) {
      return false;
    }
    sendPayloadToSession(session, payload);
    return true;
  }

  function broadcastToChannelSessions(
    channelType: ChannelType,
    session: Session,
    payload: ServerMessage,
  ) {
    if (!payload.channelType) {
      payload.channelType = channelType;
    }
    if (channelType === ADMIN_CHANNEL_TYPE) {
      broadcastToAdmins(payload);
      return;
    }
    broadcastToUser(session.userId, payload);
  }

  function getTranscriptUserId(session: Session, _channelType: ChannelType): string {
    // All channel types use the real user ID for transcript storage.
    // The DM channel (admin) differs only in session routing (main vs per-user).
    return session.userId;
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
    channelType: ChannelType,
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
            channelType,
          ) as { event: ServerMessage; sequence: number },
      );
    } catch (err: any) {
      if (err && typeof err.message === "string" && err.message.includes("FOREIGN KEY")) {
        throw new ClientMessageError("asset_not_found", "Asset not found");
      }
      throw err;
    }
  }

  async function persistAssistantMessage(
    session: Session,
    targetUserId: string,
    content: string,
    channelType: ChannelType,
  ): Promise<ServerMessage> {
    const timestamp = nowMs();
    const event: ServerMessage = {
      type: "message",
      id: generateServerMessageId(),
      role: "assistant",
      content,
      timestamp,
      streaming: false,
      channelType,
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
    if (!text.trim()) {
      throw new Error("Delivering to clawline requires --message <text>");
    }
    if (params.mediaUrl) {
      throw new Error("Clawline outbound media delivery is not supported yet");
    }
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > config.sessions.maxMessageBytes) {
      throw new Error("Clawline message exceeds max size");
    }
    const target = resolveSendTarget(targetInput);

    // Derive channelType from the stored clawlineChannelType field.
    // This field is set when messages are received, storing "admin" or "personal".
    let channelType: ChannelType = DEFAULT_CHANNEL_TYPE;
    try {
      const store = loadSessionStore(sessionStorePath);
      const mainEntry = store[mainSessionKey];
      if (mainEntry?.lastTo === target.userId && mainEntry.clawlineChannelType === "admin") {
        channelType = ADMIN_CHANNEL_TYPE;
      }
    } catch {
      // Fall back to default on error
    }

    const event: ServerMessage = {
      type: "message",
      id: generateServerMessageId(),
      role: "assistant",
      content: text,
      timestamp: nowMs(),
      streaming: false,
      channelType,
    };
    await runPerUserTask(target.userId, async () => {
      await appendEvent(event, target.userId);
    });
    if (target.kind === "device") {
      deliverToDevice(target.deviceId, event);
    } else {
      broadcastToUser(target.userId, event);
    }
    return {
      messageId: event.id,
      userId: target.userId,
      deviceId: target.kind === "device" ? target.deviceId : undefined,
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

  async function registerSession(session: Session) {
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
    await syncSessionStore(session);
  }

  async function syncSessionStore(session: Session) {
    await recordClawlineSessionActivity({
      storePath: sessionStorePath,
      sessionKey: session.sessionKey,
      sessionId: session.sessionId,
      sessionFile: path.join(
        sessionTranscriptsDir,
        `${clawlineSessionFileName(session.sessionKey)}.jsonl`,
      ),
      displayName: session.claimedName ?? session.deviceInfo?.model ?? null,
      logger,
    });
  }

  async function processClientMessage(session: Session, payload: any) {
    try {
      if (payload.type !== "message") {
        throw new ClientMessageError("invalid_message", "Unsupported type");
      }
      if (typeof payload.id !== "string" || !payload.id.startsWith("c_")) {
        throw new ClientMessageError("invalid_message", "Invalid id");
      }
      if (typeof payload.content !== "string" || payload.content.length === 0) {
        throw new ClientMessageError("invalid_message", "Missing content");
      }
      const contentBytes = Buffer.byteLength(payload.content, "utf8");
      if (contentBytes > config.sessions.maxMessageBytes) {
        throw new ClientMessageError("payload_too_large", "Message too large");
      }
      const attachmentsInfo = normalizeAttachmentsInput(payload.attachments, config.media);
      if (contentBytes + attachmentsInfo.inlineBytes > MAX_TOTAL_PAYLOAD_BYTES) {
        throw new ClientMessageError("payload_too_large", "Message too large");
      }
      const attachmentsHash = hashAttachments(attachmentsInfo.attachments);
      const channelType = normalizeChannelType(payload.channelType);
      if (channelType === ADMIN_CHANNEL_TYPE && !sessionHasAdminAccess(session)) {
        throw new ClientMessageError("forbidden", "Admin channel requires admin access");
      }
      const targetUserId = getTranscriptUserId(session, channelType);

      await runPerUserTask(session.userId, async () => {
        const existing = selectMessageStmt.get(session.deviceId, payload.id) as
          | {
              deviceId: string;
              contentHash: string;
              attachmentsHash: string;
              streaming: number;
              ackSent: number;
            }
          | undefined;
        const incomingHash = sha256(payload.content);
        if (existing) {
          if (
            existing.contentHash !== incomingHash ||
            existing.attachmentsHash !== attachmentsHash
          ) {
            throw new ClientMessageError("invalid_message", "Duplicate mismatch");
          }
          if (existing.streaming === MessageStreamingState.Failed) {
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
          channelType,
        });

        const { event } = await persistUserMessage(
          session,
          targetUserId,
          payload.id,
          payload.content,
          ownership.attachments,
          attachmentsHash,
          ownership.assetIds,
          channelType,
        );
        await new Promise<void>((resolve) => {
          session.socket.send(JSON.stringify({ type: "ack", id: payload.id }), (err) => {
            if (!err) {
              markAckSent(session.deviceId, payload.id);
            }
            resolve();
          });
        });
        broadcastToChannelSessions(channelType, session, event);

        const attachmentSummary = describeClawlineAttachments(ownership.attachments, assetsDir);
        const inboundBody = attachmentSummary
          ? `${payload.content}\n\n${attachmentSummary}`
          : payload.content;

        let route:
          | ReturnType<typeof resolveAgentRoute>
          | {
              agentId: string;
              channel: string;
              accountId: string;
              sessionKey: string;
              mainSessionKey: string;
            };
        let peerId: string;
        let channelLabel = "clawline";

        // Both channel types use the actual user ID for reply routing.
        // The difference is only session routing (main vs per-user).
        peerId = session.peerId;

        if (channelType === ADMIN_CHANNEL_TYPE) {
          // DM channel: routes to main session (like Discord/Telegram DMs)
          channelLabel = "clawline-dm";
          route = {
            agentId: mainSessionAgentId,
            channel: "clawline",
            accountId: DEFAULT_ACCOUNT_ID,
            sessionKey: mainSessionKey,
            mainSessionKey,
          };
        } else {
          // Personal channel: routes to per-user session (isolated conversation)
          // Use dmScope "per-channel-peer" to get: agent:main:clawline:dm:{userId}
          const personalSessionKey = buildAgentSessionKey({
            agentId: mainSessionAgentId,
            channel: "clawline",
            peer: { kind: "dm", id: peerId },
            dmScope: "per-channel-peer",
          });
          route = {
            agentId: mainSessionAgentId,
            channel: "clawline",
            accountId: DEFAULT_ACCOUNT_ID,
            sessionKey: personalSessionKey,
            mainSessionKey,
          };
        }

        const ctxPayload = finalizeInboundContext({
          Body: inboundBody,
          RawBody: payload.content,
          CommandBody: payload.content,
          From: `${channelLabel}:${peerId}`,
          To: `device:${session.deviceId}`,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          MessageSid: payload.id,
          ChatType: "direct",
          SenderName: session.claimedName ?? session.deviceInfo?.model ?? peerId,
          SenderId: peerId,
          Provider: "clawline",
          Surface: channelLabel,
          OriginatingChannel: channelLabel,
          OriginatingTo: peerId,
          CommandAuthorized: true,
        });

        await updateLastRoute({
          storePath: sessionStorePath,
          sessionKey: route.mainSessionKey,
          channel: channelLabel,
          to: peerId,
          accountId: route.accountId,
          clawlineChannelType: channelType,
        });

        const fallbackText = adapterOverrides.responseFallback?.trim() ?? "";
        const prefixContext: ResponsePrefixContext = {
          identityName: resolveIdentityName(clawdbotCfg, route.agentId),
        };

        const dispatcher = createReplyDispatcher({
          responsePrefix: resolveEffectiveMessagesConfig(clawdbotCfg, route.agentId).responsePrefix,
          responsePrefixContextProvider: () => prefixContext,
          humanDelay: resolveHumanDelayConfig(clawdbotCfg, route.agentId),
          deliver: async (replyPayload) => {
            const assistantText = buildAssistantTextFromPayload(replyPayload, fallbackText);
            if (!assistantText) {
              return;
            }
            const assistantEvent = await persistAssistantMessage(
              session,
              targetUserId,
              assistantText,
              channelType,
            );
            broadcastToChannelSessions(channelType, session, assistantEvent);
          },
          onError: (err, info) => {
            logger.error?.("[clawline] reply_delivery_failed", {
              kind: info.kind,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        });

        let queuedFinal = false;
        try {
          const result = await dispatchReplyFromConfig({
            ctx: ctxPayload,
            cfg: clawdbotCfg,
            dispatcher,
            replyOptions: {
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
        } catch (err) {
          logger.error?.("[clawline] dispatch_failed", err);
          queuedFinal = false;
        }
        await dispatcher.waitForIdle();

        if (!queuedFinal) {
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
          });
          return;
        }
        updateMessageStreamingStmt.run(
          MessageStreamingState.Finalized,
          session.deviceId,
          payload.id,
        );
      });
      await syncSessionStore(session);
    } catch (err) {
      if (err instanceof ClientMessageError) {
        await sendJson(session.socket, { type: "error", code: err.code, message: err.message });
        return;
      }
      throw err;
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
    const entryTtlMs = Math.max(1, config.pairing.pendingTtlSeconds) * 1000;
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
    const nextEntries = pendingFile.entries.filter((entry) => now - entry.requestedAt < entryTtlMs);
    if (nextEntries.length !== pendingFile.entries.length) {
      pendingFile = { ...pendingFile, entries: nextEntries };
      void persistPendingFile().catch((err) => logger.warn?.("pending_prune_failed", err));
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

  function hasAdmin(): boolean {
    return allowlist.entries.some((entry) => entry.isAdmin);
  }

  function validateDeviceId(value: unknown): value is string {
    return typeof value === "string" && UUID_V4_REGEX.test(value);
  }

  type ResolvedSendTarget =
    | { kind: "user"; userId: string }
    | { kind: "device"; userId: string; deviceId: string };

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
        default:
          await sendJson(ws, { type: "error", code: "invalid_message", message: "Unknown type" });
      }
    });

    ws.on("close", () => handleSocketClose(ws));
    ws.on("error", () => handleSocketClose(ws));
  });

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
      })
        .then(() => true)
        .catch(() => false);
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
        })
          .then(() => true)
          .catch(() => false);
        if (delivered) {
          await updateLastSeen(entry.deviceId, now);
        }
        ws.close();
        return;
      }
    }
    const shouldBootstrapAdmin = !hasAdmin() && normalizedUserId === ADMIN_USER_ID;
    if (shouldBootstrapAdmin) {
      const userId = ADMIN_USER_ID;
      const newEntry: AllowlistEntry = {
        deviceId,
        claimedName: sanitizedClaimedName,
        deviceInfo: sanitizedInfo,
        userId,
        isAdmin: true,
        tokenDelivered: false,
        createdAt: nowMs(),
        lastSeenAt: null,
      };
      applyIdentityPolicy(newEntry);
      allowlist.entries.push(newEntry);
      await persistAllowlist();
      const token = issueToken(newEntry);
      const delivered = await sendJson(ws, { type: "pair_result", success: true, token, userId })
        .then(() => true)
        .catch(() => false);
      if (delivered) {
        await setTokenDelivered(deviceId, true);
      }
      ws.close();
      return;
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
        // Terminate any active sessions for this device (they have the old userId)
        const existingSession = sessionsByDevice.get(deviceId);
        if (existingSession) {
          sendJson(existingSession.socket, {
            type: "error",
            code: "session_invalidated",
            message: "Account switched",
          }).catch(() => {});
          existingSession.socket.close();
          removeSession(existingSession);
        }
        // Update entry with new account info (isAdmin based on new userId)
        entry.userId = newUserId;
        entry.claimedName = sanitizedClaimedName;
        entry.deviceInfo = sanitizedInfo;
        entry.isAdmin = newUserId === ADMIN_USER_ID;
        await persistAllowlist();
      } else {
        logger.info?.("[clawline:http] pair_request_token_redispatch", { deviceId });
      }
      const token = issueToken(entry);
      const delivered = await sendJson(ws, {
        type: "pair_result",
        success: true,
        token,
        userId: entry.userId,
      })
        .then(() => true)
        .catch(() => false);
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
    const sessionKey = buildClawlineSessionKey(entry.userId);
    const peerId = derivePeerId(entry);
    const session: Session = {
      socket: ws,
      deviceId: entry.deviceId,
      userId: entry.userId,
      sessionId: `session_${randomUUID()}`,
      sessionKey,
      peerId,
      claimedName: entry.claimedName,
      deviceInfo: entry.deviceInfo
    };
    await registerSession(session);
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
      if (started) return;
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
      if (!started) return;
      allowlistWatcher.close();
      pendingFileWatcher.close();
      denylistWatcher.close();
      clearInterval(pendingCleanupInterval);
      if (assetCleanupInterval) {
        clearInterval(assetCleanupInterval);
      }
      // Force-close any active clients so shutdown doesn't hang.
      for (const client of wss.clients) {
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
      await closeWithTimeout((cb) => httpServer.close(cb), "httpServer");
      disposeDatabaseResources();
      started = false;
    },
    getPort() {
      return readBoundPort();
    },
    sendMessage: sendOutboundMessage,
  };
}
