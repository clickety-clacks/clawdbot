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
import type { Database as SqliteDatabase } from "better-sqlite3";

import { recordClawlineSessionActivity } from "./session-store.js";
import {
  buildClawlineSessionKey,
  clawlineSessionFileName,
} from "./session-key.js";
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
} from "./domain.js";
import { ClientMessageError, HttpError } from "./errors.js";
import { SlidingWindowRateLimiter } from "./rate-limiter.js";
import { createAssetHandlers } from "./http-assets.js";

export const PROTOCOL_VERSION = 1;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_REGEX = /[\u0000-\u001F\u007F]/g;
const UUID_V4_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const SERVER_EVENT_ID_REGEX = /^s_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ASSET_ID_REGEX = /^a_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const INLINE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic"]);
const MAX_ATTACHMENTS_COUNT = 4;
// Hard ceiling for a single client payload: 64 KB text budget + 256 KB inline assets + JSON overhead.
const MAX_TOTAL_PAYLOAD_BYTES = 320 * 1024;

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
    appVersion: sanitizeField(info.appVersion)
  };
}

function normalizeAttachmentsInput(
  raw: unknown,
  mediaConfig: ProviderConfig["media"]
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
  if (value.osVersion !== undefined && (!requiredString(value.osVersion) && value.osVersion !== "")) {
    return false;
  }
  if (value.appVersion !== undefined && (!requiredString(value.appVersion) && value.appVersion !== "")) {
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
  sessionId: string;
  sessionKey: string;
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
  content: string;
  timestamp: number;
  streaming: boolean;
  attachments?: unknown[];
  deviceId?: string;
};

enum MessageStreamingState {
  Finalized = 0,
  Active = 1,
  Failed = 2
}

const DEFAULT_CONFIG: ProviderConfig = {
  port: 18792,
  statePath: path.join(os.homedir(), ".clawdbot", "clawline"),
  network: {
    bindAddress: "127.0.0.1",
    allowInsecurePublic: false,
    allowedOrigins: []
  },
  adapter: null,
  auth: {
    jwtSigningKey: null,
    tokenTtlSeconds: 31_536_000,
    maxAttemptsPerMinute: 5,
    reissueGraceSeconds: 600
  },
  pairing: {
    maxPendingRequests: 100,
    maxRequestsPerMinute: 5,
    pendingTtlSeconds: 300
  },
  media: {
    storagePath: path.join(os.homedir(), ".clawdbot", "clawline-media"),
    maxInlineBytes: 262_144,
    maxUploadBytes: 104_857_600,
    unreferencedUploadTtlSeconds: 3600
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
    streamInactivitySeconds: 300
  },
  streams: {
    chunkPersistIntervalMs: 100,
    chunkBufferBytes: 1_048_576
  }
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
  return loadJsonFile<PendingFile>(filePath, { version: 1, entries: [] });
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
     RETURNING nextSequence as sequence`
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
      : `{"type":"asset","assetId":${quote(attachment.assetId)}}`
  );
  return sha256(`[${parts.join(",")}]`);
}

type AdapterExecutionResult = { exitCode?: number; output?: string } | string;

function normalizeAdapterResult(result: AdapterExecutionResult): { exitCode: number; output: string } {
  if (typeof result === "string") {
    return { exitCode: 0, output: result };
  }
  return {
    exitCode: result?.exitCode ?? 0,
    output: result?.output ?? ""
  };
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

function buildPromptFromEvents(
  events: ServerMessage[],
  maxPromptMessages: number,
  appendedUserContent: string
): string {
  const trimmed = events
    .filter((event) => event.role === "user" || event.role === "assistant")
    .slice(-maxPromptMessages + 1);
  const lines = trimmed.map((event) => `${event.role === "user" ? "User" : "Assistant"}: ${event.content}`);
  lines.push(`User: ${appendedUserContent}`);
  return lines.join("\n");
}

function parseServerMessage(json: string): ServerMessage {
  return JSON.parse(json) as ServerMessage;
}

export async function createProviderServer(options: ProviderOptions): Promise<ProviderServer> {
  const config = mergeConfig(options.config);
  const logger: Logger = options.logger ?? console;
  const sessionStorePath = options.sessionStorePath;
  const sessionTranscriptsDir = path.join(config.statePath, "sessions");

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

  const allowlistPath = path.join(config.statePath, ALLOWLIST_FILENAME);
  const pendingPath = path.join(config.statePath, PENDING_FILENAME);
  const denylistPath = path.join(config.statePath, DENYLIST_FILENAME);
  const jwtKeyPath = path.join(config.statePath, JWT_KEY_FILENAME);
  const dbPath = path.join(config.statePath, DB_FILENAME);

  let allowlist = await loadAllowlist(allowlistPath);
  let pendingFile = await loadPending(pendingPath);
  let denylist = await loadDenylist(denylistPath);
  const jwtKey = await ensureJwtKey(jwtKeyPath, config.auth.jwtSigningKey);

  const db = new BetterSqlite3(dbPath, { fileMustExist: false });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
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

  const sequenceStatement = userSequenceStmt(db);
  const insertEventStmt = db.prepare(
    `INSERT INTO events (id, userId, sequence, originatingDeviceId, payloadJson, payloadBytes, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const updateMessageAckStmt = db.prepare(`UPDATE messages SET ackSent = 1 WHERE deviceId = ? AND clientId = ?`);
  const insertMessageStmt = db.prepare(
    `INSERT INTO messages (deviceId, userId, clientId, serverEventId, serverSequence, content, contentHash, attachmentsHash, timestamp, streaming, ackSent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${MessageStreamingState.Active}, 0)`
  );
  const selectMessageStmt = db.prepare(
    `SELECT deviceId, userId, clientId, serverEventId, serverSequence, content, contentHash, attachmentsHash, timestamp, streaming, ackSent
     FROM messages WHERE deviceId = ? AND clientId = ?`
  );
  const updateMessageStreamingStmt = db.prepare(`UPDATE messages SET streaming = ? WHERE deviceId = ? AND clientId = ?`);
  const insertMessageAssetStmt = db.prepare(
    `INSERT INTO message_assets (deviceId, clientId, assetId) VALUES (?, ?, ?)`
  );
  const insertAssetStmt = db.prepare(
    `INSERT INTO assets (assetId, userId, mimeType, size, createdAt, uploaderDeviceId) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const selectAssetStmt = db.prepare(
    `SELECT assetId, userId, mimeType, size, createdAt FROM assets WHERE assetId = ?`
  );
  const selectExpiredAssetsStmt = db.prepare(
    `SELECT assetId FROM assets
     WHERE createdAt <= ?
       AND NOT EXISTS (
         SELECT 1 FROM message_assets WHERE message_assets.assetId = assets.assetId
       )`
  );
  const deleteAssetStmt = db.prepare(
    `DELETE FROM assets
     WHERE assetId = ?
       AND NOT EXISTS (
         SELECT 1 FROM message_assets WHERE message_assets.assetId = assets.assetId
       )`
  );
  const {
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
  });

  await cleanupTmpDirectory();
  await cleanupOrphanedAssetFiles();
  const insertUserMessageTx = db.transaction(
    (
      session: Session,
      messageId: string,
      content: string,
      timestamp: number,
      attachments: NormalizedAttachment[],
      attachmentsHash: string,
      assetIds: string[]
    ) => {
      for (const assetId of assetIds) {
        const asset = selectAssetStmt.get(assetId) as { assetId: string; userId: string } | undefined;
        if (!asset || asset.userId !== session.userId) {
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
        attachments: attachments.length > 0 ? attachments : undefined
      };
      const payloadJson = JSON.stringify(event);
      const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
      const sequenceRow = sequenceStatement.get(session.userId) as { sequence: number };
      insertEventStmt.run(
        serverMessageId,
        session.userId,
        sequenceRow.sequence,
        session.deviceId,
        payloadJson,
        payloadBytes,
        timestamp
      );
      insertMessageStmt.run(
        session.deviceId,
        session.userId,
        messageId,
        serverMessageId,
        sequenceRow.sequence,
        content,
        sha256(content),
        attachmentsHash,
        timestamp
      );
      for (const assetId of assetIds) {
        insertMessageAssetStmt.run(session.deviceId, messageId, assetId);
      }
      return { event, sequence: sequenceRow.sequence };
    }
  );

  type EventRow = { id: string; payloadJson: string };
  const selectEventsAfterStmt = db.prepare(
    `SELECT id, payloadJson FROM events WHERE userId = ? AND sequence > ? ORDER BY sequence ASC`
  );
  const selectEventsTailStmt = db.prepare(
    `SELECT id, payloadJson FROM events WHERE userId = ? ORDER BY sequence DESC LIMIT ?`
  );
  const selectAnchorStmt = db.prepare(
    `SELECT sequence FROM events WHERE id = ? AND userId = ?`
  );
  const insertEventTx = db.transaction((event: ServerMessage, userId: string, originatingDeviceId?: string) => {
    const payloadJson = JSON.stringify(event);
    const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
    const sequenceRow = sequenceStatement.get(userId) as { sequence: number };
    insertEventStmt.run(event.id, userId, sequenceRow.sequence, originatingDeviceId ?? null, payloadJson, payloadBytes, event.timestamp);
    return sequenceRow.sequence;
  });

  const logHttpRequest = (info: Record<string, unknown>) => {
    logger.info?.("[clawline:http]", info);
  };

  const httpServer = http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        logHttpRequest({ event: "request_missing_url", method: req.method ?? "UNKNOWN" });
        res.writeHead(404).end();
        return;
      }
      const parsedUrl = new URL(req.url, "http://localhost");
      logHttpRequest({
        event: "request_received",
        method: req.method ?? "UNKNOWN",
        path: parsedUrl.pathname
      });
      if (req.method === "GET" && parsedUrl.pathname === "/version") {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(200);
        res.end(JSON.stringify({ protocolVersion: PROTOCOL_VERSION }));
        logHttpRequest({ event: "request_handled", method: req.method, path: parsedUrl.pathname, status: 200 });
        return;
      }
      if (req.method === "POST" && parsedUrl.pathname === "/upload") {
        logHttpRequest({ event: "upload_start" });
        await handleUpload(req, res);
        logHttpRequest({ event: "upload_complete" });
        return;
      }
      if (req.method === "GET" && parsedUrl.pathname.startsWith("/download/")) {
        const assetId = parsedUrl.pathname.slice("/download/".length);
        logHttpRequest({ event: "download_start", assetId });
        await handleDownload(req, res, assetId);
        logHttpRequest({ event: "download_complete", assetId });
        return;
      }
      logHttpRequest({
        event: "request_not_found",
        method: req.method ?? "UNKNOWN",
        path: parsedUrl.pathname
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

  const sockets = new Set<net.Socket>();
  httpServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    if (request.url !== "/ws") {
      socket.destroy();
      return;
    }
    if (config.network.allowedOrigins && config.network.allowedOrigins.length > 0) {
      const origin = request.headers.origin ?? "null";
      if (!config.network.allowedOrigins.includes(origin)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
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
  const messageRateLimiter = new SlidingWindowRateLimiter(config.sessions.maxMessagesPerSecond, 1_000);
  let writeQueue: Promise<void> = Promise.resolve();
  const pendingCleanupInterval = setInterval(() => expirePendingPairs(), 1_000);
  if (typeof pendingCleanupInterval.unref === "function") {
    pendingCleanupInterval.unref();
  }
  const maintenanceIntervalMs = Math.min(60_000, Math.max(1_000, config.media.unreferencedUploadTtlSeconds * 250));
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
      () => undefined
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
        (entry) => !denylist.some((existing) => existing.deviceId === entry.deviceId)
      );
      denylist = next;
      for (const revoked of newlyRevoked) {
        const session = sessionsByDevice.get(revoked.deviceId);
        if (session) {
          sendJson(session.socket, { type: "error", code: "token_revoked", message: "Device revoked" })
            .catch(() => {})
            .finally(() => session.socket.close(1008));
        }
      }
      for (const [deviceId, pending] of pendingSockets) {
        if (isDenylisted(deviceId)) {
          pendingSockets.delete(deviceId);
          void removePendingEntry(deviceId).catch(() => {});
          void sendJson(pending.socket, { type: "pair_result", success: false, reason: "pair_rejected" })
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
      userId: entry.userId
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
      iat: Math.floor(Date.now() / 1000)
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
    return new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new Error("socket not open"));
        return;
      }
      ws.send(JSON.stringify(payload), (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
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
    return { deviceId, userId: entry.userId };
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

  function selectEventsAfter(userId: string, lastMessageId: string | null) {
    if (!lastMessageId) {
      const rows = selectEventsTailStmt.all(userId, config.sessions.maxReplayMessages) as EventRow[];
      return rows.map((row) => parseServerMessage(row.payloadJson)).reverse();
    }
    const anchor = selectAnchorStmt.get(lastMessageId, userId) as
      | { sequence: number }
      | undefined;
    if (!anchor) {
      const tail = selectEventsTailStmt.all(userId, config.sessions.maxReplayMessages) as EventRow[];
      return tail.map((row) => parseServerMessage(row.payloadJson)).reverse();
    }
    const rows = selectEventsAfterStmt.all(userId, anchor.sequence) as EventRow[];
    return rows.map((row) => parseServerMessage(row.payloadJson));
  }

  async function sendReplay(session: Session, lastMessageId: string | null) {
    const events = selectEventsAfter(session.userId, lastMessageId);
    const payload = {
      type: "auth_result",
      success: true,
      userId: session.userId,
      sessionId: session.sessionId,
      replayCount: events.length,
      replayTruncated: false,
      historyReset: lastMessageId ? false : true
    };
    await sendJson(session.socket, payload);
    for (const event of events) {
      await sendJson(session.socket, event);
    }
  }

  function broadcastToUser(userId: string, payload: ServerMessage) {
    const sessions = userSessions.get(userId);
    if (!sessions) return;
    for (const session of sessions) {
      if (session.socket.readyState !== WebSocket.OPEN) continue;
      session.socket.send(JSON.stringify(payload), (err) => {
        if (err) {
          session.socket.close();
        }
      });
    }
  }

  async function appendEvent(event: ServerMessage, userId: string, originatingDeviceId?: string) {
    return enqueueWriteTask(() => insertEventTx(event, userId, originatingDeviceId));
  }

  async function persistUserMessage(
    session: Session,
    messageId: string,
    content: string,
    attachments: NormalizedAttachment[],
    attachmentsHash: string,
    assetIds: string[]
  ): Promise<{ event: ServerMessage; sequence: number }> {
    const timestamp = nowMs();
    try {
      return await enqueueWriteTask(() =>
        insertUserMessageTx(session, messageId, content, timestamp, attachments, attachmentsHash, assetIds)
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
    content: string
  ): Promise<ServerMessage> {
    const timestamp = nowMs();
    const event: ServerMessage = {
      type: "message",
      id: generateServerMessageId(),
      role: "assistant",
      content,
      timestamp,
      streaming: false
    };
    await appendEvent(event, session.userId);
    return event;
  }

  function getConversationEvents(userId: string) {
    const rows = db
      .prepare(`SELECT payloadJson FROM events WHERE userId = ? ORDER BY sequence ASC LIMIT ?`)
      .all(userId, config.sessions.maxPromptMessages - 1) as Array<{ payloadJson: string }>;
    return rows.map((row) => parseServerMessage(row.payloadJson));
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
      sendJson(existing.socket, { type: "error", code: "session_replaced", message: "Session replaced" })
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
          if (existing.contentHash !== incomingHash || existing.attachmentsHash !== attachmentsHash) {
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

        const { event } = await persistUserMessage(
          session,
          payload.id,
          payload.content,
          attachmentsInfo.attachments,
          attachmentsHash,
          attachmentsInfo.assetIds
        );
        await new Promise<void>((resolve) => {
          session.socket.send(JSON.stringify({ type: "ack", id: payload.id }), (err) => {
            if (!err) {
              markAckSent(session.deviceId, payload.id);
            }
            resolve();
          });
        });
        broadcastToUser(session.userId, event);

        const priorEvents = getConversationEvents(session.userId);
        const prompt = buildPromptFromEvents(priorEvents, config.sessions.maxPromptMessages, payload.content);
        try {
          const adapterResult = await Promise.race<AdapterExecutionResult>([
            options.adapter.execute({
              prompt,
              userId: session.userId,
              sessionId: session.sessionId,
              deviceId: session.deviceId
            }),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("adapter_timeout")), config.sessions.adapterExecuteTimeoutSeconds * 1000)
            )
          ]);
          const normalizedResult = normalizeAdapterResult(adapterResult);
          if ((normalizedResult.exitCode ?? 0) !== 0) {
            updateMessageStreamingStmt.run(MessageStreamingState.Failed, session.deviceId, payload.id);
            await sendJson(session.socket, {
              type: "error",
              code: "server_error",
              message: "Adapter error",
              messageId: payload.id
            });
            return;
          }
          const assistantEvent = await persistAssistantMessage(session, normalizedResult.output ?? "");
          broadcastToUser(session.userId, assistantEvent);
          updateMessageStreamingStmt.run(MessageStreamingState.Finalized, session.deviceId, payload.id);
        } catch (err) {
          updateMessageStreamingStmt.run(MessageStreamingState.Failed, session.deviceId, payload.id);
          await sendJson(session.socket, {
            type: "error",
            code: "server_error",
            message: "Adapter failure",
            messageId: payload.id
          });
        }
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
    if (config.pairing.pendingTtlSeconds <= 0) {
      return;
    }
    const now = nowMs();
    const ttlMs = config.pairing.pendingTtlSeconds * 1000;
    for (const [deviceId, pending] of pendingSockets) {
      if (now - pending.createdAt >= config.pairing.pendingTtlSeconds * 1000) {
        pendingSockets.delete(deviceId);
        void removePendingEntry(deviceId).catch(() => {});
        void sendJson(pending.socket, { type: "pair_result", success: false, reason: "pair_timeout" })
          .catch(() => {})
          .finally(() => {
            pending.socket.close(1000);
          });
      }
    }
    const nextEntries = pendingFile.entries.filter((entry) => now - entry.requestedAt < ttlMs);
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
        void removePendingEntry(deviceId).catch((err) => logger.warn?.("pending_cleanup_failed", err));
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

  wss.on("connection", (ws) => {
    connectionState.set(ws, { authenticated: false });

    ws.on("message", async (raw) => {
      let payload: any;
      try {
        payload = JSON.parse(raw.toString());
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
    if (payload.protocolVersion !== PROTOCOL_VERSION) {
      await sendJson(ws, { type: "error", code: "invalid_message", message: "Unsupported protocol" });
      ws.close();
      return;
    }
    if (!validateDeviceId(payload.deviceId)) {
      await sendJson(ws, { type: "error", code: "invalid_message", message: "Invalid deviceId" });
      return;
    }
    if (!pairRateLimiter.attempt(payload.deviceId)) {
      await sendJson(ws, { type: "error", code: "rate_limited", message: "Pairing rate limited" });
      ws.close(1008);
      return;
    }
    if (isDenylisted(payload.deviceId)) {
      await sendJson(ws, { type: "pair_result", success: false, reason: "pair_rejected" });
      ws.close();
      return;
    }
    if (!validateDeviceInfo(payload.deviceInfo)) {
      await sendJson(ws, { type: "error", code: "invalid_message", message: "Invalid device info" });
      return;
    }
    const sanitizedInfo = sanitizeDeviceInfo(payload.deviceInfo);
    if (!sanitizedInfo.platform || !sanitizedInfo.model) {
      await sendJson(ws, { type: "error", code: "invalid_message", message: "Invalid device info" });
      return;
    }
    const sanitizedClaimedName = sanitizeLabel(payload.claimedName);
    const deviceId = payload.deviceId;
    const entry = findAllowlistEntry(deviceId);
    if (entry && !entry.tokenDelivered) {
      const token = issueToken(entry);
      const delivered = await sendJson(ws, { type: "pair_result", success: true, token, userId: entry.userId })
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
        const delivered = await sendJson(ws, { type: "pair_result", success: true, token, userId: entry.userId })
          .then(() => true)
          .catch(() => false);
        if (delivered) {
          await updateLastSeen(entry.deviceId, now);
        }
        ws.close();
        return;
      }
    }
    if (!hasAdmin()) {
      const userId = generateUserId();
      const newEntry: AllowlistEntry = {
        deviceId,
        claimedName: sanitizedClaimedName,
        deviceInfo: sanitizedInfo,
        userId,
        isAdmin: true,
        tokenDelivered: false,
        createdAt: nowMs(),
        lastSeenAt: null
      };
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
      await sendJson(ws, { type: "error", code: "invalid_message", message: "Device already paired" });
      ws.close();
      return;
    }

    const existingPendingEntry = findPendingEntry(deviceId);
    const pendingCount = pendingFile.entries.length + (existingPendingEntry ? 0 : 1);
    if (pendingCount > config.pairing.maxPendingRequests) {
      await sendJson(ws, { type: "error", code: "rate_limited", message: "Too many pending requests" });
      ws.close(1008);
      return;
    }
    const now = nowMs();
    const pendingEntry: PendingEntry = {
      deviceId,
      claimedName: sanitizedClaimedName,
      deviceInfo: sanitizedInfo,
      requestedAt: existingPendingEntry ? existingPendingEntry.requestedAt : now
    };
    await upsertPendingEntry(pendingEntry);
    const existingSocket = pendingSockets.get(deviceId);
    if (existingSocket) {
      existingSocket.socket.close(1000);
    }
    pendingSockets.set(deviceId, {
      deviceId,
      socket: ws,
      claimedName: sanitizedClaimedName,
      deviceInfo: sanitizedInfo,
      createdAt: now
    });
  }

  async function handleAuth(ws: WebSocket, payload: any) {
    if (payload.protocolVersion !== PROTOCOL_VERSION) {
      await sendJson(ws, { type: "error", code: "invalid_message", message: "Unsupported protocol" });
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
    if (typeof decoded.deviceId !== "string" || !timingSafeStringEqual(decoded.deviceId, payload.deviceId)) {
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
    const sessionKey = buildClawlineSessionKey(entry.userId, entry.deviceId);
    const session: Session = {
      socket: ws,
      deviceId: entry.deviceId,
      userId: entry.userId,
      isAdmin: entry.isAdmin,
      sessionId: `session_${randomUUID()}`,
      sessionKey,
      claimedName: entry.claimedName,
      deviceInfo: entry.deviceInfo
    };
    await registerSession(session);
    connectionState.set(ws, {
      authenticated: true,
      deviceId: session.deviceId,
      userId: session.userId,
      isAdmin: session.isAdmin,
      sessionId: session.sessionId
    });
    try {
      await updateLastSeen(session.deviceId, nowMs());
      const lastMessageId =
        typeof payload.lastMessageId === "string" ? payload.lastMessageId : null;
      if (typeof payload.lastMessageId === "string" && !SERVER_EVENT_ID_REGEX.test(payload.lastMessageId)) {
        await sendJson(ws, { type: "error", code: "invalid_message", message: "Invalid lastMessageId" });
        ws.close();
        return;
      }
      await sendReplay(session, lastMessageId);
    } catch {
      removeSession(session);
      connectionState.delete(ws);
      await sendJson(ws, { type: "error", code: "server_error", message: "Replay failed" }).catch(() => {});
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
      if (started) return;
      await new Promise<void>((resolve) => {
        httpServer.listen(config.port, config.network.bindAddress, () => resolve());
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
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            logger.warn("shutdown_timeout", { label });
            reject(new Error(`${label} close timeout`));
          }, 5000);
          fn(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      await closeWithTimeout((cb) => wss.close(cb), "wss");
      await closeWithTimeout((cb) => httpServer.close(cb), "httpServer");
      db.close();
      started = false;
    },
    getPort() {
      return readBoundPort();
    }
  };
}
