import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import { runCommandWithTimeout } from "../process/exec.js";
import type { Logger } from "./domain.js";

const SURF_ACE_SERVICE_TYPE = "_surf-ace._tcp";
const SCREEN_STATE_FILE = "surf-ace-screens.json";
const DEFAULT_DISCOVERY_INTERVAL_MS = 5_000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 1_500;
const DEFAULT_WS_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_WS_REQUEST_TIMEOUT_MS = 10_000;
const PAIR_RESPONSE_TIMEOUT_MS = 10_000;
const DEFAULT_WS_MAX_MESSAGE_BYTES = 12 * 1024 * 1024;
const SURF_ACE_SESSION_ID_PATTERN = /^sa_[A-Za-z0-9._:-]{8,128}$/;
const WS_HEARTBEAT_INTERVAL_MS = 10_000;
const WS_HEARTBEAT_TIMEOUT_MS = 3_000;
const WS_MAX_CONSECUTIVE_MISSED_PONGS = 2;
const WS_RECONNECT_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
const SURF_ACE_ALERT_SESSION_KEY = "agent:main:main";
const SURF_ACE_APPEND_REGISTER_CAP = 512;

type SurfAceWireMode = "content" | "frame";

type SurfAceToolErrorCode =
  | "screen_not_found"
  | "not_connected"
  | "content_too_large"
  | "unsupported_content_type"
  | "render_failed"
  | "stale_content"
  | "internal_error";

export type SurfAceConnectionState = "connected" | "connecting" | "unreachable";

export type SurfAceListScreen = {
  fingerprint: string;
  name: string;
  connectionState: SurfAceConnectionState;
  lastSeenAt: number;
  viewport: {
    width: number;
    height: number;
    scale: number;
  };
  activeContent: {
    contentId: string;
    contentType: string;
    revision: number;
  } | null;
  pendingEvents: number;
};

export type SurfAceListResult = SurfAceListScreen[];

export type SurfAcePushResult = {
  fingerprint: string;
  contentId: string;
  revision: number;
};

export type SurfAceClearResult = {
  fingerprint: string;
  revision: number;
};

export type SurfAceReadResult = {
  fingerprint: string;
  taps: Array<Record<string, unknown>>;
  drawingActivity: Array<Record<string, unknown>>;
  scrollPosition: Record<string, unknown> | null;
  selection: Record<string, unknown> | null;
  page: Record<string, unknown> | null;
  snapshotHint: boolean;
  playbackPosition: number | null;
  playbackState: string | null;
  annotations: Array<Record<string, unknown>>;
  overflowed: boolean;
  readAt: number;
};

export type SurfAceAnnotationsRemoveResult = {
  fingerprint: string;
  removedStrokeIds: string[];
  notFoundStrokeIds: string[];
  remainingStrokeCount: number;
};

export interface SurfAceRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  list(params: { userId: string | null }): Promise<SurfAceListResult>;
  push(params: {
    userId: string | null;
    fingerprint: string;
    contentType: string;
    content: string;
  }): Promise<SurfAcePushResult>;
  clear(params: { userId: string | null; fingerprint: string }): Promise<SurfAceClearResult>;
  read(params: { userId: string | null; fingerprint: string }): Promise<SurfAceReadResult>;
  annotationsRemove(params: {
    userId: string | null;
    fingerprint: string;
    contentId: string;
    strokeIds: string[];
  }): Promise<SurfAceAnnotationsRemoveResult>;
}

type PersistedScreenStateEntry = {
  fingerprint: string;
  host: string;
  port: number;
  name?: string;
  intake?: "bonjour" | "manual";
  wsPath?: string;
  wsSecure?: boolean;
  protocolVersion?: number;
  width?: number;
  height?: number;
  scale?: number;
  contentTypes?: number;
  sessionToken: string | null;
  currentContentId?: string | null;
  currentRevision?: number;
  currentContentType?: string | null;
  lastSeenAt?: number;
};

type ScreenStateFile = {
  version: 2;
  providerId?: string;
  screens: PersistedScreenStateEntry[];
};

type DiscoveryRecord = {
  instanceName: string;
  host: string;
  port: number;
  txt: Record<string, string>;
};

type SurfAceManagerOptions = {
  statePath: string;
  logger?: Logger;
  discoveryIntervalMs?: number;
  discoveryTimeoutMs?: number;
  wsConnectTimeoutMs?: number;
  wsRequestTimeoutMs?: number;
  wsHeartbeatIntervalMs?: number;
  wsHeartbeatTimeoutMs?: number;
  wsReconnectBackoffMs?: number[];
  fetchImpl?: typeof fetch;
  discoverImpl?: (timeoutMs: number) => Promise<DiscoveryRecord[]>;
  now?: () => number;
};

type ManagedScreen = {
  id: string;
  instanceName: string;
  host: string;
  port: number;
  name: string;
  protocolVersion: number;
  width: number;
  height: number;
  scale: number;
  contentTypes: number;
  fingerprint: string;
  intake: "bonjour" | "manual";
  lastSeenAt: number;
  wsPath: string;
  wsSecure: boolean;
  maxMessageBytes: number;
  currentRevision: number;
  currentContentId: string | null;
  currentContentType: string | null;
  consecutiveFailures: number;
  unreachable: boolean;
  sessionToken: string | null;
  eventBuffer: SurfAceEventBuffer;
  wireMode: SurfAceWireMode;
};

type SurfAceEventBuffer = {
  taps: Array<Record<string, unknown>>;
  drawingActivity: Array<Record<string, unknown>>;
  scrollPosition: Record<string, unknown> | null;
  selection: Record<string, unknown> | null;
  page: Record<string, unknown> | null;
  snapshotHint: boolean;
  annotations: Array<Record<string, unknown>>;
  playbackPosition: number | null;
  playbackState: string | null;
  appendOrder: Array<"tap" | "drawing">;
  dirty: boolean;
  alertFired: boolean;
  overflowed: boolean;
  pendingEvents: number;
};

type SurfAceRequestEnvelope = {
  v: 1;
  type: "request";
  op: string;
  id: string;
  sentAt: number;
  payload: Record<string, unknown>;
};

type SurfAceResponseEnvelope = {
  v: 1;
  type: "response";
  op: string;
  id: string;
  ok: boolean;
  sentAt: number;
  payload?: Record<string, unknown>;
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
};

type SurfAceEventEnvelope = {
  v: 1;
  type: "event";
  op: string;
  eventId?: string;
  sentAt?: number;
  payload?: Record<string, unknown>;
};

type PendingRequest = {
  op: string;
  resolve: (value: SurfAceResponseEnvelope) => void;
  reject: (reason?: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type ScreenSocketState = {
  ws: WebSocket | null;
  pendingRequests: Map<string, PendingRequest>;
  connectPromise: Promise<void> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempt: number;
  requestSequence: number;
  paired: boolean;
  shouldReconnect: boolean;
  forceTakeoverOnNextPair: boolean;
  awaitingSnapshotAfterReconnect: boolean;
  bufferedEvents: SurfAceEventEnvelope[];
  seenEventIds: Set<string>;
  seenEventOrder: string[];
  heartbeatInterval: ReturnType<typeof setInterval> | null;
  consecutiveMissedPongs: number;
};

type ToolError = Error & { code: SurfAceToolErrorCode };

function buildToolError(code: SurfAceToolErrorCode, message: string): ToolError {
  const err = new Error(message) as ToolError;
  err.code = code;
  return err;
}

function isToolError(value: unknown): value is ToolError {
  if (!value || typeof value !== "object") {
    return false;
  }
  const code = (value as { code?: unknown }).code;
  return typeof code === "string";
}

function createEventBuffer(): SurfAceEventBuffer {
  return {
    taps: [],
    drawingActivity: [],
    scrollPosition: null,
    selection: null,
    page: null,
    snapshotHint: false,
    annotations: [],
    playbackPosition: null,
    playbackState: null,
    appendOrder: [],
    dirty: false,
    alertFired: false,
    overflowed: false,
    pendingEvents: 0,
  };
}

function decodeDnsSdEscapes(value: string): string {
  let decoded = false;
  const bytes: number[] = [];
  let pending = "";

  const flush = () => {
    if (!pending) {
      return;
    }
    bytes.push(...Buffer.from(pending, "utf8"));
    pending = "";
  };

  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i] ?? "";
    if (ch === "\\" && i + 1 < value.length && /\s/.test(value[i + 1] ?? "")) {
      pending += value[i + 1];
      decoded = true;
      i += 1;
      continue;
    }
    if (ch === "\\" && i + 3 < value.length) {
      const escaped = value.slice(i + 1, i + 4);
      if (/^[0-9]{3}$/.test(escaped)) {
        const byte = Number.parseInt(escaped, 10);
        if (Number.isFinite(byte) && byte >= 0 && byte <= 255) {
          flush();
          bytes.push(byte);
          decoded = true;
          i += 3;
          continue;
        }
      }
    }
    pending += ch;
  }

  if (!decoded) {
    return value;
  }
  flush();
  return Buffer.from(bytes).toString("utf8");
}

function parseBrowseInstances(stdout: string): string[] {
  const instances = new Set<string>();
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line || !line.includes("Add") || !line.includes(SURF_ACE_SERVICE_TYPE)) {
      continue;
    }
    const match = line.match(/_surf-ace\._tcp\.?\s+(.+)$/i);
    if (match?.[1]) {
      instances.add(decodeDnsSdEscapes(match[1].trim()));
    }
  }
  return Array.from(instances.values());
}

function splitDnsSdTokens(line: string): string[] {
  const tokens: string[] = [];
  let token = "";

  const pushToken = () => {
    if (!token) {
      return;
    }
    tokens.push(token);
    token = "";
  };

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] ?? "";
    if (ch === "\\" && i + 1 < line.length && /\s/.test(line[i + 1] ?? "")) {
      token += `\\${line[i + 1] ?? ""}`;
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      pushToken();
      continue;
    }
    token += ch;
  }

  pushToken();
  return tokens;
}

function parseTxtTokens(tokens: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const token of tokens) {
    const idx = token.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = token.slice(0, idx).trim();
    const value = decodeDnsSdEscapes(token.slice(idx + 1).trim());
    if (key) {
      out[key] = value;
    }
  }
  return out;
}

function parseResolve(stdout: string, instanceName: string): DiscoveryRecord | null {
  let host: string | null = null;
  let port: number | null = null;
  let txt: Record<string, string> = {};

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.includes("can be reached at")) {
      const match = line.match(/can be reached at\s+([^\s:]+):(\d+)/i);
      if (match?.[1] && match[2]) {
        host = match[1].replace(/\.$/, "");
        const parsedPort = Number.parseInt(match[2], 10);
        if (Number.isFinite(parsedPort) && parsedPort > 0) {
          port = parsedPort;
        }
      }
      continue;
    }

    if (line.startsWith("txt") || line.includes("=")) {
      const tokens = splitDnsSdTokens(line).filter((entry) => entry.includes("="));
      const parsed = parseTxtTokens(tokens);
      if (Object.keys(parsed).length > 0) {
        txt = { ...txt, ...parsed };
      }
    }
  }

  if (!host || !port) {
    return null;
  }
  return {
    instanceName,
    host,
    port,
    txt,
  };
}

export async function discoverSurfAceScreens(timeoutMs: number): Promise<DiscoveryRecord[]> {
  const browse = await runCommandWithTimeout(["dns-sd", "-B", SURF_ACE_SERVICE_TYPE, "local."], {
    timeoutMs,
  });
  const instances = parseBrowseInstances(browse.stdout);
  const results: DiscoveryRecord[] = [];
  for (const instanceName of instances) {
    const resolved = await runCommandWithTimeout(
      ["dns-sd", "-L", instanceName, SURF_ACE_SERVICE_TYPE, "local."],
      { timeoutMs },
    );
    const parsed = parseResolve(resolved.stdout, instanceName);
    if (parsed) {
      results.push(parsed);
    }
  }
  return results;
}

function parseIntSafe(value: string | undefined, fallback = 0): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function normalizeFingerprint(value: string | undefined): string {
  const raw = (value ?? "").trim().toLowerCase();
  return /^[0-9a-f]{8}$/.test(raw) ? raw : "";
}

function normalizeScreenName(record: DiscoveryRecord): string {
  const fromTxt = record.txt.name?.trim();
  if (fromTxt) {
    return decodeDnsSdEscapes(fromTxt);
  }
  return decodeDnsSdEscapes(record.instanceName);
}

function normalizeAddressHost(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("::ffff:")) {
    return trimmed.slice("::ffff:".length);
  }
  return trimmed;
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function buildContentId(): string {
  return `ct_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function buildFrameId(): string {
  return `fr_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function buildWireContentId(mode: SurfAceWireMode): string {
  return mode === "frame" ? buildFrameId() : buildContentId();
}

function buildProviderId(): string {
  return `pv_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function buildConnectionId(): string {
  return `cn_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

function buildRequestId(sequence: number): string {
  return `rq_${sequence.toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function normalizeWsPath(value: string | undefined): string {
  const raw = (value ?? "").trim();
  if (!raw) {
    return "/ws";
  }
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function contentTypesMaskFromNames(value: unknown): number | null {
  if (!Array.isArray(value)) {
    return null;
  }
  let mask = 0;
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    switch (item.trim().toLowerCase()) {
      case "html":
        mask |= 1;
        break;
      case "image":
        mask |= 2;
        break;
      case "pdf":
        mask |= 4;
        break;
      case "terminal":
        mask |= 8;
        break;
      case "markdown":
        mask |= 16;
        break;
      case "video":
        mask |= 32;
        break;
      case "canvas":
        mask |= 64;
        break;
      default:
        break;
    }
  }
  return mask;
}

function contentTypeMaskFor(type: string): number {
  switch (type) {
    case "html":
      return 1;
    case "image":
      return 2;
    case "pdf":
      return 4;
    case "terminal":
      return 8;
    case "markdown":
      return 16;
    case "video":
      return 32;
    case "canvas":
      return 64;
    default:
      return 0;
  }
}

function clampSnapshotToRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  return payload as Record<string, unknown>;
}

function rawDataByteLength(rawData: WebSocket.RawData): number {
  if (typeof rawData === "string") {
    return Buffer.byteLength(rawData, "utf8");
  }
  if (Buffer.isBuffer(rawData)) {
    return rawData.byteLength;
  }
  if (Array.isArray(rawData)) {
    return rawData.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  }
  return Buffer.from(rawData).byteLength;
}

function normalizeValidSessionId(value: string | null | undefined): string | null {
  const token = value?.trim() ?? "";
  if (!token) {
    return null;
  }
  return SURF_ACE_SESSION_ID_PATTERN.test(token) ? token : null;
}

function toText(rawData: WebSocket.RawData): string {
  if (typeof rawData === "string") {
    return rawData;
  }
  if (Buffer.isBuffer(rawData)) {
    return rawData.toString("utf8");
  }
  if (Array.isArray(rawData)) {
    return Buffer.concat(rawData).toString("utf8");
  }
  return Buffer.from(rawData).toString("utf8");
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

function eventActivityLabel(op: string): string {
  switch (op) {
    case "event.drawing_flush":
      return "drawing activity";
    case "event.tap":
      return "tap activity";
    case "event.selection":
      return "selection activity";
    case "event.page":
      return "page activity";
    case "event.snapshot_hint":
      return "snapshot hint";
    case "event.scroll":
      return "scroll activity";
    default:
      return "surface activity";
  }
}

function normalizeContentType(value: string): string {
  return value.trim().toLowerCase();
}

function isUnknownOperationPayloadError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const message = err.message.toLowerCase();
  return message.includes("(invalid_payload)") && message.includes("unknown operation");
}

class SurfAceManager implements SurfAceRuntime {
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly discoverImpl: (timeoutMs: number) => Promise<DiscoveryRecord[]>;
  private readonly now: () => number;
  private readonly screenStatePath: string;
  private readonly discoveryIntervalMs: number;
  private readonly discoveryTimeoutMs: number;
  private readonly wsConnectTimeoutMs: number;
  private readonly wsRequestTimeoutMs: number;
  private readonly wsHeartbeatIntervalMs: number;
  private readonly wsHeartbeatTimeoutMs: number;
  private readonly wsReconnectBackoffMs: number[];
  private readonly screensById = new Map<string, ManagedScreen>();
  private readonly socketsByScreenId = new Map<string, ScreenSocketState>();
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private discoveryInFlight = false;
  private screenStateWrite: Promise<void> = Promise.resolve();
  private providerId = buildProviderId();
  private stopping = false;

  constructor(options: SurfAceManagerOptions) {
    this.logger = options.logger ?? console;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.discoverImpl = options.discoverImpl ?? discoverSurfAceScreens;
    this.now = options.now ?? (() => Date.now());
    this.screenStatePath = path.join(options.statePath, SCREEN_STATE_FILE);
    this.discoveryIntervalMs =
      options.discoveryIntervalMs && Number.isFinite(options.discoveryIntervalMs)
        ? Math.max(250, Math.floor(options.discoveryIntervalMs))
        : DEFAULT_DISCOVERY_INTERVAL_MS;
    this.discoveryTimeoutMs =
      options.discoveryTimeoutMs && Number.isFinite(options.discoveryTimeoutMs)
        ? Math.max(250, Math.floor(options.discoveryTimeoutMs))
        : DEFAULT_DISCOVERY_TIMEOUT_MS;
    this.wsConnectTimeoutMs =
      options.wsConnectTimeoutMs && Number.isFinite(options.wsConnectTimeoutMs)
        ? Math.max(250, Math.floor(options.wsConnectTimeoutMs))
        : DEFAULT_WS_CONNECT_TIMEOUT_MS;
    this.wsRequestTimeoutMs =
      options.wsRequestTimeoutMs && Number.isFinite(options.wsRequestTimeoutMs)
        ? Math.max(250, Math.floor(options.wsRequestTimeoutMs))
        : DEFAULT_WS_REQUEST_TIMEOUT_MS;
    this.wsHeartbeatIntervalMs =
      options.wsHeartbeatIntervalMs && Number.isFinite(options.wsHeartbeatIntervalMs)
        ? Math.max(250, Math.floor(options.wsHeartbeatIntervalMs))
        : WS_HEARTBEAT_INTERVAL_MS;
    this.wsHeartbeatTimeoutMs =
      options.wsHeartbeatTimeoutMs && Number.isFinite(options.wsHeartbeatTimeoutMs)
        ? Math.max(250, Math.floor(options.wsHeartbeatTimeoutMs))
        : WS_HEARTBEAT_TIMEOUT_MS;
    this.wsReconnectBackoffMs =
      Array.isArray(options.wsReconnectBackoffMs) && options.wsReconnectBackoffMs.length > 0
        ? options.wsReconnectBackoffMs
            .map((value) => (Number.isFinite(value) ? Math.max(250, Math.floor(value)) : 0))
            .filter((value) => value > 0)
        : [...WS_RECONNECT_BACKOFF_MS];
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.loadScreenState();
    await this.refreshDiscovery();
    if (!this.discoveryTimer) {
      this.discoveryTimer = setInterval(() => {
        void this.refreshDiscovery();
      }, this.discoveryIntervalMs);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    for (const [screenId, socketState] of this.socketsByScreenId.entries()) {
      socketState.shouldReconnect = false;
      this.stopHeartbeat(socketState);
      if (socketState.reconnectTimer) {
        clearTimeout(socketState.reconnectTimer);
        socketState.reconnectTimer = null;
      }
      this.rejectAllPendingRequests(socketState, new Error("Surf Ace manager stopped"));
      try {
        socketState.ws?.close(1000, "provider_shutdown");
      } catch {
        // ignore
      }
      socketState.ws = null;
      socketState.paired = false;
      this.socketsByScreenId.set(screenId, socketState);
    }
  }

  async list(_params: { userId: string | null }): Promise<SurfAceListResult> {
    return Array.from(this.screensById.values())
      .map((screen) => this.toPublicScreen(screen))
      .toSorted((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  }

  async push(params: {
    userId: string | null;
    fingerprint: string;
    contentType: string;
    content: string;
  }): Promise<SurfAcePushResult> {
    const screen = this.resolveScreenByFingerprint(params.fingerprint);
    this.requireConnected(screen);

    const contentType = normalizeContentType(params.contentType);
    if (!this.isSupportedContentType(screen, contentType)) {
      throw buildToolError(
        "unsupported_content_type",
        `surf_ace_push failed (unsupported_content_type): ${contentType}`,
      );
    }

    const wireMode = screen.wireMode;
    const contentId = buildWireContentId(wireMode);
    const nextRevision = screen.currentRevision + 1;
    const encodedContent = this.encodeContentPayload(contentType, params.content);
    const payload: Record<string, unknown> =
      wireMode === "frame"
        ? {
            frameId: contentId,
            revision: nextRevision,
            contentType,
            content: encodedContent,
          }
        : {
            contentId,
            revision: nextRevision,
            contentType,
            content: encodedContent,
          };
    let response: SurfAceResponseEnvelope;

    try {
      response = await this.sendScreenRequest(
        screen,
        wireMode === "frame" ? "frame.set" : "content.set",
        payload,
      );
    } catch (err) {
      if (wireMode === "content" && isUnknownOperationPayloadError(err)) {
        screen.wireMode = "frame";
        const frameId = buildWireContentId("frame");
        response = await this.sendScreenRequest(screen, "frame.set", {
          frameId,
          revision: nextRevision,
          contentType,
          content: encodedContent,
        });
      } else {
        throw this.normalizeToolError(err, "internal_error", "surf_ace_push failed");
      }
    }

    try {
      const responsePayload = clampSnapshotToRecord(response.payload);
      const currentRevision = parseOptionalNumber(responsePayload.currentRevision);
      const currentContentId = firstNonEmptyString(
        responsePayload.currentContentId,
        responsePayload.currentFrameId,
        responsePayload.frameId,
      );
      const currentContentType =
        typeof responsePayload.contentType === "string" ? responsePayload.contentType : null;
      screen.currentRevision = currentRevision ?? nextRevision;
      screen.currentContentId = currentContentId ?? contentId;
      screen.currentContentType = currentContentType ?? contentType;
      screen.eventBuffer.annotations = [];
      await this.persistScreenState();
      return {
        fingerprint: screen.fingerprint,
        contentId: screen.currentContentId,
        revision: screen.currentRevision,
      };
    } catch (err) {
      throw this.normalizeToolError(err, "internal_error", "surf_ace_push failed");
    }
  }

  async clear(params: { userId: string | null; fingerprint: string }): Promise<SurfAceClearResult> {
    const screen = this.resolveScreenByFingerprint(params.fingerprint);
    this.requireConnected(screen);

    const nextRevision = screen.currentRevision + 1;
    try {
      let response: SurfAceResponseEnvelope;
      try {
        response = await this.sendScreenRequest(
          screen,
          screen.wireMode === "frame" ? "frame.clear" : "content.clear",
          {
            revision: nextRevision,
          },
        );
      } catch (err) {
        if (screen.wireMode === "content" && isUnknownOperationPayloadError(err)) {
          screen.wireMode = "frame";
          response = await this.sendScreenRequest(screen, "frame.clear", {
            revision: nextRevision,
          });
        } else {
          throw err;
        }
      }
      const payload = clampSnapshotToRecord(response.payload);
      const currentRevision = parseOptionalNumber(payload.currentRevision);
      screen.currentRevision = currentRevision ?? nextRevision;
      screen.currentContentId = null;
      screen.currentContentType = null;
      screen.eventBuffer.annotations = [];
      await this.persistScreenState();
      return {
        fingerprint: screen.fingerprint,
        revision: screen.currentRevision,
      };
    } catch (err) {
      throw this.normalizeToolError(err, "internal_error", "surf_ace_clear failed");
    }
  }

  async read(params: { userId: string | null; fingerprint: string }): Promise<SurfAceReadResult> {
    const screen = this.resolveScreenByFingerprint(params.fingerprint);
    const buffer = screen.eventBuffer;
    const result: SurfAceReadResult = {
      fingerprint: screen.fingerprint,
      taps: [...buffer.taps],
      drawingActivity: [...buffer.drawingActivity],
      scrollPosition: buffer.scrollPosition,
      selection: buffer.selection,
      page: buffer.page,
      snapshotHint: buffer.snapshotHint,
      playbackPosition: buffer.playbackPosition,
      playbackState: buffer.playbackState,
      annotations: [...buffer.annotations],
      overflowed: buffer.overflowed,
      readAt: this.now(),
    };

    buffer.taps = [];
    buffer.drawingActivity = [];
    buffer.appendOrder = [];
    buffer.scrollPosition = null;
    buffer.selection = null;
    buffer.page = null;
    buffer.snapshotHint = false;
    buffer.playbackPosition = null;
    buffer.playbackState = null;
    buffer.dirty = false;
    buffer.alertFired = false;
    buffer.overflowed = false;
    buffer.pendingEvents = 0;

    return result;
  }

  async annotationsRemove(params: {
    userId: string | null;
    fingerprint: string;
    contentId: string;
    strokeIds: string[];
  }): Promise<SurfAceAnnotationsRemoveResult> {
    const screen = this.resolveScreenByFingerprint(params.fingerprint);
    this.requireConnected(screen);

    if (!screen.currentContentId || screen.currentContentId !== params.contentId) {
      throw buildToolError(
        "stale_content",
        "surf_ace_annotations_remove failed (stale_content): contentId does not match",
      );
    }

    const strokeIds = params.strokeIds
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    if (strokeIds.length === 0) {
      return {
        fingerprint: screen.fingerprint,
        removedStrokeIds: [],
        notFoundStrokeIds: [],
        remainingStrokeCount: screen.eventBuffer.annotations.length,
      };
    }

    try {
      const response = await this.sendScreenRequest(
        screen,
        "annotations.remove",
        screen.wireMode === "frame"
          ? {
              frameId: params.contentId,
              strokeIds,
            }
          : {
              contentId: params.contentId,
              strokeIds,
            },
      );
      const payload = clampSnapshotToRecord(response.payload);
      const removedStrokeIds = asStringArray(payload.removedStrokeIds);
      const notFoundStrokeIds = asStringArray(payload.notFoundStrokeIds);
      const remainingStrokeCount =
        typeof payload.remainingStrokeCount === "number" &&
        Number.isFinite(payload.remainingStrokeCount)
          ? Math.max(0, Math.floor(payload.remainingStrokeCount))
          : Math.max(0, screen.eventBuffer.annotations.length - removedStrokeIds.length);

      if (removedStrokeIds.length > 0) {
        const removed = new Set(removedStrokeIds);
        screen.eventBuffer.annotations = screen.eventBuffer.annotations.filter((stroke) => {
          const strokeId = typeof stroke.strokeId === "string" ? stroke.strokeId : "";
          return strokeId ? !removed.has(strokeId) : true;
        });
      }

      return {
        fingerprint: screen.fingerprint,
        removedStrokeIds,
        notFoundStrokeIds,
        remainingStrokeCount,
      };
    } catch (err) {
      throw this.normalizeToolError(err, "internal_error", "surf_ace_annotations_remove failed");
    }
  }

  private socketStateFor(screenId: string): ScreenSocketState {
    const existing = this.socketsByScreenId.get(screenId);
    if (existing) {
      return existing;
    }
    const created: ScreenSocketState = {
      ws: null,
      pendingRequests: new Map(),
      connectPromise: null,
      reconnectTimer: null,
      reconnectAttempt: 0,
      requestSequence: 0,
      paired: false,
      shouldReconnect: false,
      forceTakeoverOnNextPair: false,
      awaitingSnapshotAfterReconnect: false,
      bufferedEvents: [],
      seenEventIds: new Set<string>(),
      seenEventOrder: [],
      heartbeatInterval: null,
      consecutiveMissedPongs: 0,
    };
    this.socketsByScreenId.set(screenId, created);
    return created;
  }

  private buildScreenWsUrl(screen: ManagedScreen): string {
    const pathName = normalizeWsPath(screen.wsPath);
    return `ws://${screen.host}:${screen.port}${pathName}`;
  }

  private ensureConnectionJob(screen: ManagedScreen): void {
    const state = this.socketStateFor(screen.id);
    state.shouldReconnect = true;
    if (this.stopping) {
      return;
    }
    if (state.connectPromise || state.reconnectTimer) {
      return;
    }
    if (state.ws && state.ws.readyState === WebSocket.OPEN && state.paired) {
      return;
    }
    void this.ensureScreenSocketPaired(screen, {
      forcePairRequest: true,
      isReconnect: Boolean(screen.sessionToken),
    })
      .then(async () => {
        await this.persistScreenState();
      })
      .catch((err) => {
        this.logger.warn?.(
          `[clawline:surf-ace] connect_job_failed(${screen.name}): ${String(err)}`,
        );
        this.scheduleReconnect(screen, state);
      });
  }

  private stopConnectionJob(screen: ManagedScreen): void {
    const state = this.socketStateFor(screen.id);
    state.shouldReconnect = false;
    this.stopHeartbeat(state);
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    this.rejectAllPendingRequests(state, new Error("Surf Ace connection job stopped"));
    try {
      state.ws?.close(1000, "provider_shutdown");
    } catch {
      // ignore
    }
    state.ws = null;
    state.paired = false;
    screen.unreachable = true;
  }

  private async ensureScreenSocketPaired(
    screen: ManagedScreen,
    options: { forcePairRequest: boolean; isReconnect: boolean },
  ): Promise<void> {
    const state = this.socketStateFor(screen.id);
    if (state.connectPromise) {
      await state.connectPromise;
      if (!options.forcePairRequest) {
        return;
      }
    }

    const run = async () => {
      state.shouldReconnect = true;
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        state.ws = await this.openScreenSocket(screen);
        this.bindScreenSocketHandlers(screen, state, state.ws);
        state.paired = false;
      }
      if (state.paired && !options.forcePairRequest) {
        return;
      }
      await this.sendPairRequest(screen, state, options.isReconnect);
    };

    state.connectPromise = run()
      .catch((err) => {
        screen.consecutiveFailures += 1;
        if (screen.consecutiveFailures >= 3) {
          screen.unreachable = true;
        }
        throw err;
      })
      .finally(() => {
        state.connectPromise = null;
      });
    await state.connectPromise;
  }

  private async openScreenSocket(screen: ManagedScreen): Promise<WebSocket> {
    const wsUrl = this.buildScreenWsUrl(screen);
    const ws = new WebSocket(wsUrl, {
      handshakeTimeout: this.wsConnectTimeoutMs,
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        reject(new Error(`Surf Ace connect timeout (${wsUrl})`));
      }, this.wsConnectTimeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        ws.off("open", onOpen);
        ws.off("error", onError);
        ws.off("close", onClose);
      };

      const onOpen = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };

      const onError = (err: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(err);
      };

      const onClose = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(new Error(`Surf Ace socket closed during connect (${wsUrl})`));
      };

      ws.once("open", onOpen);
      ws.once("error", onError);
      ws.once("close", onClose);
    });
    return ws;
  }

  private bindScreenSocketHandlers(
    screen: ManagedScreen,
    state: ScreenSocketState,
    ws: WebSocket,
  ): void {
    ws.on("message", (data) => {
      this.handleScreenSocketMessage(screen, state, data);
    });
    ws.on("error", (err) => {
      this.logger.warn?.(`[clawline:surf-ace] socket_error(${screen.name}): ${String(err)}`);
    });
    ws.on("close", (code) => {
      this.handleScreenSocketClose(screen, state, ws, code);
    });
  }

  private handleScreenSocketMessage(
    screen: ManagedScreen,
    state: ScreenSocketState,
    rawData: WebSocket.RawData,
  ): void {
    if (rawDataByteLength(rawData) > screen.maxMessageBytes) {
      try {
        state.ws?.close(4413, "payload_too_large");
      } catch {
        // ignore
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(toText(rawData));
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }

    const envelope = parsed as Record<string, unknown>;
    const type = typeof envelope.type === "string" ? envelope.type : "";
    if (type === "response") {
      const response = envelope as unknown as SurfAceResponseEnvelope;
      const requestId = typeof response.id === "string" ? response.id : "";
      if (!requestId) {
        return;
      }
      const pending = state.pendingRequests.get(requestId);
      if (!pending) {
        return;
      }
      state.pendingRequests.delete(requestId);
      clearTimeout(pending.timeout);
      pending.resolve(response);
      return;
    }

    if (type !== "event") {
      return;
    }

    const eventEnvelope = envelope as unknown as SurfAceEventEnvelope;
    const op = typeof eventEnvelope.op === "string" ? eventEnvelope.op : "";
    if (
      op !== "event.drawing_flush" &&
      op !== "event.tap" &&
      op !== "event.selection" &&
      op !== "event.page" &&
      op !== "event.snapshot_hint" &&
      op !== "event.scroll"
    ) {
      return;
    }

    const normalizedEvent: SurfAceEventEnvelope = {
      v: 1,
      type: "event",
      op,
      eventId: typeof eventEnvelope.eventId === "string" ? eventEnvelope.eventId : undefined,
      sentAt: typeof eventEnvelope.sentAt === "number" ? eventEnvelope.sentAt : undefined,
      payload: clampSnapshotToRecord(eventEnvelope.payload),
    };

    if (state.awaitingSnapshotAfterReconnect) {
      if (state.bufferedEvents.length >= 128) {
        state.bufferedEvents.shift();
        this.logger.warn?.(
          `[clawline:surf-ace] reconnect_event_buffer_overflow(${screen.name}); dropping oldest event`,
        );
      }
      state.bufferedEvents.push(normalizedEvent);
      return;
    }

    this.applyEventEnvelope(screen, state, normalizedEvent);
  }

  private applyEventEnvelope(
    screen: ManagedScreen,
    state: ScreenSocketState,
    eventEnvelope: SurfAceEventEnvelope,
  ): void {
    const eventId = typeof eventEnvelope.eventId === "string" ? eventEnvelope.eventId : "";
    if (eventId) {
      if (state.seenEventIds.has(eventId)) {
        return;
      }
      state.seenEventIds.add(eventId);
      state.seenEventOrder.push(eventId);
      while (state.seenEventOrder.length > 1_024) {
        const oldest = state.seenEventOrder.shift();
        if (oldest) {
          state.seenEventIds.delete(oldest);
        }
      }
    }

    const payload = clampSnapshotToRecord(eventEnvelope.payload);
    const timestamp =
      typeof eventEnvelope.sentAt === "number" && Number.isFinite(eventEnvelope.sentAt)
        ? eventEnvelope.sentAt
        : this.now();
    const buffer = screen.eventBuffer;

    if (typeof payload.playbackPosition === "number" && Number.isFinite(payload.playbackPosition)) {
      buffer.playbackPosition = payload.playbackPosition;
    }
    if (typeof payload.playbackState === "string") {
      buffer.playbackState = payload.playbackState;
    }

    if (eventEnvelope.op === "event.tap") {
      const position =
        payload.position && typeof payload.position === "object" && !Array.isArray(payload.position)
          ? (payload.position as Record<string, unknown>)
          : null;
      buffer.taps.push({
        eventId: eventEnvelope.eventId ?? `ev_${timestamp}`,
        timestamp,
        x: typeof position?.x === "number" ? position.x : null,
        y: typeof position?.y === "number" ? position.y : null,
        nearestText:
          typeof payload.nearestContent === "string" ? payload.nearestContent : undefined,
        elementRole: typeof payload.elementRole === "string" ? payload.elementRole : undefined,
      });
      buffer.appendOrder.push("tap");
      this.enforceAppendCap(buffer);
    } else if (eventEnvelope.op === "event.drawing_flush") {
      const strokes = Array.isArray(payload.strokes)
        ? payload.strokes.filter(
            (stroke): stroke is Record<string, unknown> =>
              Boolean(stroke) && typeof stroke === "object" && !Array.isArray(stroke),
          )
        : [];
      const strokeIdsAdded: string[] = [];
      for (const stroke of strokes) {
        const strokeId = typeof stroke.strokeId === "string" ? stroke.strokeId : "";
        if (!strokeId) {
          continue;
        }
        strokeIdsAdded.push(strokeId);
        const withoutExisting = buffer.annotations.filter((item) => item.strokeId !== strokeId);
        buffer.annotations = [...withoutExisting, stroke];
      }
      const flushId = typeof payload.flushId === "string" ? payload.flushId : `flush_${timestamp}`;
      buffer.drawingActivity.push({
        flushId,
        timestamp,
        strokeIdsAdded,
      });
      buffer.appendOrder.push("drawing");
      this.enforceAppendCap(buffer);
    } else if (eventEnvelope.op === "event.selection") {
      const selectionRaw =
        payload.selection &&
        typeof payload.selection === "object" &&
        !Array.isArray(payload.selection)
          ? (payload.selection as Record<string, unknown>)
          : null;
      if (!selectionRaw) {
        buffer.selection = null;
      } else {
        buffer.selection = {
          selectedText:
            typeof selectionRaw.text === "string"
              ? selectionRaw.text
              : typeof selectionRaw.selectedText === "string"
                ? selectionRaw.selectedText
                : null,
          bounds:
            selectionRaw.boundingRect &&
            typeof selectionRaw.boundingRect === "object" &&
            !Array.isArray(selectionRaw.boundingRect)
              ? selectionRaw.boundingRect
              : selectionRaw.bounds &&
                  typeof selectionRaw.bounds === "object" &&
                  !Array.isArray(selectionRaw.bounds)
                ? selectionRaw.bounds
                : null,
          anchorStart: selectionRaw.anchorStart,
          anchorEnd: selectionRaw.anchorEnd,
        };
      }
    } else if (eventEnvelope.op === "event.page") {
      buffer.page = {
        pageNumber: typeof payload.page === "number" ? payload.page : null,
        pageCount: typeof payload.totalPages === "number" ? payload.totalPages : null,
        pageLabel:
          typeof payload.pageLabel === "string"
            ? payload.pageLabel
            : typeof payload.pageText === "string"
              ? payload.pageText
              : undefined,
      };
    } else if (eventEnvelope.op === "event.snapshot_hint") {
      buffer.snapshotHint = true;
      // TODO(surf-ace:v2-open-questions): snapshot-hint cache strategy may change with Appendix A
      // decisions around annotation coordinate space and semantic region capture.
      void this.refreshSnapshotForScreen(screen, { includeDrawings: false });
    } else if (eventEnvelope.op === "event.scroll") {
      const viewport =
        payload.viewport && typeof payload.viewport === "object" && !Array.isArray(payload.viewport)
          ? (payload.viewport as Record<string, unknown>)
          : null;
      const scrollOffset =
        viewport?.scrollOffset &&
        typeof viewport.scrollOffset === "object" &&
        !Array.isArray(viewport.scrollOffset)
          ? (viewport.scrollOffset as Record<string, unknown>)
          : null;
      buffer.scrollPosition = {
        x: typeof scrollOffset?.x === "number" ? scrollOffset.x : null,
        y: typeof scrollOffset?.y === "number" ? scrollOffset.y : null,
        visibleRect:
          viewport?.visibleRect &&
          typeof viewport.visibleRect === "object" &&
          !Array.isArray(viewport.visibleRect)
            ? viewport.visibleRect
            : null,
      };
    }

    buffer.pendingEvents += 1;
    if (!buffer.dirty) {
      buffer.dirty = true;
      buffer.alertFired = false;
    }
    if (!buffer.alertFired) {
      buffer.alertFired = true;
      void this.postActivityAlert(screen, eventActivityLabel(eventEnvelope.op));
    }
  }

  private enforceAppendCap(buffer: SurfAceEventBuffer): void {
    while (buffer.taps.length + buffer.drawingActivity.length > SURF_ACE_APPEND_REGISTER_CAP) {
      const oldest = buffer.appendOrder.shift();
      if (oldest === "tap") {
        if (buffer.taps.length > 0) {
          buffer.taps.shift();
        } else if (buffer.drawingActivity.length > 0) {
          buffer.drawingActivity.shift();
        }
      } else if (oldest === "drawing") {
        if (buffer.drawingActivity.length > 0) {
          buffer.drawingActivity.shift();
        } else if (buffer.taps.length > 0) {
          buffer.taps.shift();
        }
      } else if (buffer.taps.length > 0) {
        buffer.taps.shift();
      } else {
        buffer.drawingActivity.shift();
      }
      buffer.overflowed = true;
    }
  }

  private async postActivityAlert(screen: ManagedScreen, activity: string): Promise<void> {
    const message = `Surf Ace activity on ${screen.name}: ${activity}`;
    const body = JSON.stringify({
      sessionKey: SURF_ACE_ALERT_SESSION_KEY,
      message,
      noOverlay: true,
    });
    try {
      await this.fetchImpl("http://localhost:18800/alert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    } catch {
      // Best effort only.
    }
  }

  private handleScreenSocketClose(
    screen: ManagedScreen,
    state: ScreenSocketState,
    ws: WebSocket,
    code: number,
  ): void {
    if (state.ws !== ws) {
      return;
    }
    state.ws = null;
    state.paired = false;
    this.stopHeartbeat(state);
    this.rejectAllPendingRequests(
      state,
      new Error(`Surf Ace socket closed (${screen.name}) with code ${String(code)}`),
    );
    if (this.stopping || !state.shouldReconnect) {
      return;
    }
    this.scheduleReconnect(screen, state);
  }

  private scheduleReconnect(screen: ManagedScreen, state: ScreenSocketState): void {
    if (state.reconnectTimer || this.stopping || !state.shouldReconnect) {
      return;
    }
    const backoff =
      this.wsReconnectBackoffMs.length > 0
        ? this.wsReconnectBackoffMs
        : [...WS_RECONNECT_BACKOFF_MS];
    const index = Math.min(state.reconnectAttempt, backoff.length - 1);
    const baseDelay = backoff[index] ?? backoff.at(-1) ?? 30_000;
    const jitter = 0.8 + Math.random() * 0.4;
    const delayMs = Math.max(250, Math.floor(baseDelay * jitter));
    state.reconnectAttempt += 1;
    if (state.reconnectAttempt >= backoff.length) {
      screen.unreachable = true;
    }
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      void this.reconnectScreen(screen, state);
    }, delayMs);
  }

  private async reconnectScreen(screen: ManagedScreen, state: ScreenSocketState): Promise<void> {
    if (this.stopping || !state.shouldReconnect) {
      return;
    }
    try {
      await this.ensureScreenSocketPaired(screen, {
        forcePairRequest: true,
        isReconnect: Boolean(screen.sessionToken),
      });
      await this.persistScreenState();
    } catch (err) {
      this.logger.warn?.(`[clawline:surf-ace] reconnect_failed(${screen.name}): ${String(err)}`);
      this.scheduleReconnect(screen, state);
    }
  }

  private async sendPairRequest(
    screen: ManagedScreen,
    state: ScreenSocketState,
    isReconnect: boolean,
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      providerId: this.providerId,
      connectionId: buildConnectionId(),
      providerName: "clawline-provider",
      protocolVersion: 1,
      eventProfile: "minimum_deep",
    };

    if (screen.sessionToken) {
      const validSessionId = normalizeValidSessionId(screen.sessionToken);
      if (validSessionId) {
        payload.resume = { sessionId: validSessionId };
      } else {
        screen.sessionToken = null;
      }
    }
    if (state.forceTakeoverOnNextPair) {
      payload.takeover = true;
    }

    let response: SurfAceResponseEnvelope;
    try {
      response = await this.sendScreenRequest(
        screen,
        "pair.request",
        payload,
        PAIR_RESPONSE_TIMEOUT_MS,
      );
    } catch (err) {
      const isTimeout =
        err instanceof Error &&
        (err.message.includes("pair.request timed out") ||
          err.message.includes("Surf Ace pair.request timed out"));
      if (isTimeout) {
        try {
          state.ws?.close(4000, "pair_timeout");
        } catch {
          // ignore
        }
      }
      throw err;
    }

    const pairPayload = clampSnapshotToRecord(response.payload);
    const sessionId =
      typeof pairPayload.sessionId === "string" && pairPayload.sessionId.trim().length > 0
        ? pairPayload.sessionId.trim()
        : "";
    if (!sessionId) {
      throw new Error(`Screen "${screen.name}" did not return sessionId.`);
    }

    const surfaceName =
      typeof pairPayload.surfaceName === "string" && pairPayload.surfaceName.trim().length > 0
        ? pairPayload.surfaceName.trim()
        : null;
    if (surfaceName) {
      screen.name = surfaceName;
      screen.instanceName = surfaceName;
    }

    const viewport =
      pairPayload.viewport &&
      typeof pairPayload.viewport === "object" &&
      !Array.isArray(pairPayload.viewport)
        ? (pairPayload.viewport as Record<string, unknown>)
        : null;
    if (viewport) {
      screen.width = parseOptionalNumber(viewport.width) ?? screen.width;
      screen.height = parseOptionalNumber(viewport.height) ?? screen.height;
      screen.scale = parseOptionalNumber(viewport.scale) ?? screen.scale;
    }

    const capabilities =
      pairPayload.capabilities &&
      typeof pairPayload.capabilities === "object" &&
      !Array.isArray(pairPayload.capabilities)
        ? (pairPayload.capabilities as Record<string, unknown>)
        : null;
    if (capabilities) {
      const mask = contentTypesMaskFromNames(capabilities.contentTypes);
      if (mask !== null) {
        screen.contentTypes = mask;
      }
    }

    const limits =
      pairPayload.limits &&
      typeof pairPayload.limits === "object" &&
      !Array.isArray(pairPayload.limits)
        ? (pairPayload.limits as Record<string, unknown>)
        : null;
    if (limits) {
      const maxMessageBytes = parseOptionalNumber(limits.maxMessageBytes);
      if (maxMessageBytes && maxMessageBytes > 0) {
        screen.maxMessageBytes = maxMessageBytes;
      }
    }

    const statePayload =
      pairPayload.state &&
      typeof pairPayload.state === "object" &&
      !Array.isArray(pairPayload.state)
        ? (pairPayload.state as Record<string, unknown>)
        : null;
    if (statePayload) {
      const currentRevision = parseOptionalNumber(statePayload.currentRevision);
      const hasCurrentFrameId = Object.hasOwn(statePayload, "currentFrameId");
      const hasCurrentContentId = Object.hasOwn(statePayload, "currentContentId");
      if (hasCurrentFrameId && !hasCurrentContentId) {
        screen.wireMode = "frame";
      } else if (hasCurrentContentId) {
        screen.wireMode = "content";
      }
      const currentContentId = firstNonEmptyString(
        statePayload.currentContentId,
        statePayload.currentFrameId,
      );
      const currentContentType =
        typeof statePayload.contentType === "string" ? statePayload.contentType : null;
      screen.currentRevision = currentRevision ?? screen.currentRevision;
      screen.currentContentId = currentContentId;
      screen.currentContentType = currentContentType;
    }

    screen.sessionToken = sessionId;
    screen.unreachable = false;
    screen.consecutiveFailures = 0;
    screen.lastSeenAt = this.now();
    state.paired = true;
    state.reconnectAttempt = 0;
    state.forceTakeoverOnNextPair = false;
    this.startHeartbeat(screen, state);

    if (isReconnect) {
      try {
        state.awaitingSnapshotAfterReconnect = true;
        await this.refreshSnapshotForScreen(screen, { includeDrawings: false });
      } catch (err) {
        state.awaitingSnapshotAfterReconnect = false;
        state.bufferedEvents = [];
        try {
          state.ws?.close(4000, "snapshot_resync_failed");
        } catch {
          // ignore
        }
        throw err;
      } finally {
        state.awaitingSnapshotAfterReconnect = false;
      }

      const bufferedEvents = [...state.bufferedEvents];
      state.bufferedEvents = [];
      for (const bufferedEvent of bufferedEvents) {
        this.applyEventEnvelope(screen, state, bufferedEvent);
      }
    }
  }

  private startHeartbeat(screen: ManagedScreen, state: ScreenSocketState): void {
    this.stopHeartbeat(state);
    state.consecutiveMissedPongs = 0;
    state.heartbeatInterval = setInterval(() => {
      void this.sendHeartbeatPing(screen, state);
    }, this.wsHeartbeatIntervalMs);
  }

  private stopHeartbeat(state: ScreenSocketState): void {
    if (state.heartbeatInterval) {
      clearInterval(state.heartbeatInterval);
      state.heartbeatInterval = null;
    }
  }

  private async sendHeartbeatPing(screen: ManagedScreen, state: ScreenSocketState): Promise<void> {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN || !state.paired) {
      return;
    }
    const nonce = randomUUID();
    try {
      const response = await this.sendScreenRequest(
        screen,
        "heartbeat.ping",
        { nonce },
        this.wsHeartbeatTimeoutMs,
      );
      const payload = clampSnapshotToRecord(response.payload);
      if (typeof payload.nonce !== "string" || payload.nonce !== nonce) {
        throw new Error("invalid heartbeat response nonce");
      }
      state.consecutiveMissedPongs = 0;
    } catch {
      state.consecutiveMissedPongs += 1;
      if (state.consecutiveMissedPongs >= WS_MAX_CONSECUTIVE_MISSED_PONGS) {
        state.forceTakeoverOnNextPair = true;
        try {
          state.ws?.close(4000, "heartbeat_timeout");
        } catch {
          // ignore
        }
      }
    }
  }

  private async sendScreenRequest(
    screen: ManagedScreen,
    op: string,
    payload: Record<string, unknown>,
    timeoutMs = this.wsRequestTimeoutMs,
  ): Promise<SurfAceResponseEnvelope> {
    const state = this.socketStateFor(screen.id);
    const ws = state.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw buildToolError("not_connected", `screen ${screen.fingerprint} is not connected`);
    }

    const requestId = buildRequestId(++state.requestSequence);
    const request: SurfAceRequestEnvelope = {
      v: 1,
      type: "request",
      op,
      id: requestId,
      sentAt: this.now(),
      payload,
    };

    const response = await new Promise<SurfAceResponseEnvelope>((resolve, reject) => {
      const timeout = setTimeout(() => {
        state.pendingRequests.delete(requestId);
        reject(new Error(`Surf Ace ${op} timed out.`));
      }, timeoutMs);

      state.pendingRequests.set(requestId, {
        op,
        resolve,
        reject,
        timeout,
      });

      ws.send(JSON.stringify(request), (err) => {
        if (!err) {
          return;
        }
        const pending = state.pendingRequests.get(requestId);
        if (!pending) {
          return;
        }
        state.pendingRequests.delete(requestId);
        clearTimeout(pending.timeout);
        reject(err);
      });
    });

    if (response.op !== op) {
      throw new Error(`Surf Ace response op mismatch: expected ${op}, got ${response.op}`);
    }

    if (!response.ok) {
      const code =
        response.error && typeof response.error.code === "string"
          ? response.error.code
          : "internal_error";
      const message =
        response.error && typeof response.error.message === "string"
          ? response.error.message
          : `Surf Ace ${op} failed`;

      if (
        code === "content_too_large" ||
        code === "unsupported_content_type" ||
        code === "render_failed" ||
        code === "stale_content"
      ) {
        throw buildToolError(code, `${message} (${code})`);
      }
      if (code === "not_paired") {
        throw buildToolError("not_connected", `${message} (${code})`);
      }
      throw buildToolError("internal_error", `${message} (${code})`);
    }

    return response;
  }

  private rejectAllPendingRequests(state: ScreenSocketState, error: Error): void {
    for (const [id, pending] of state.pendingRequests.entries()) {
      state.pendingRequests.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  private async refreshSnapshotForScreen(
    screen: ManagedScreen,
    options: { includeDrawings: boolean },
  ): Promise<void> {
    const state = this.socketStateFor(screen.id);
    if (!state.paired) {
      return;
    }

    const response = await this.sendScreenRequest(screen, "snapshot.get", {
      includeVisibleText: true,
      includeDrawings: options.includeDrawings,
    });

    const payload = clampSnapshotToRecord(response.payload);
    const contentId = firstNonEmptyString(payload.contentId, payload.frameId);
    const revision = parseOptionalNumber(payload.revision);
    const contentType = typeof payload.contentType === "string" ? payload.contentType : null;

    screen.currentContentId = contentId;
    screen.currentContentType = contentType;
    if (revision !== undefined) {
      screen.currentRevision = revision;
    }

    if (options.includeDrawings && Array.isArray(payload.drawings)) {
      const drawings = payload.drawings.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
      );
      screen.eventBuffer.annotations = drawings;
    }
  }

  private async refreshDiscovery(): Promise<void> {
    if (this.discoveryInFlight) {
      return;
    }
    this.discoveryInFlight = true;
    try {
      const discovered = await this.discoverImpl(this.discoveryTimeoutMs);
      const seenFingerprints = new Set<string>();
      const now = this.now();

      for (const record of discovered) {
        const fingerprint = normalizeFingerprint(record.txt.pk);
        if (!fingerprint) {
          continue;
        }
        seenFingerprints.add(fingerprint);
        const existing = this.screensById.get(fingerprint);
        const name = normalizeScreenName(record);
        const wsPath = normalizeWsPath(record.txt.ws);

        if (existing) {
          existing.intake = "bonjour";
          existing.instanceName = record.instanceName;
          existing.host = normalizeAddressHost(record.host);
          existing.port = record.port;
          existing.name = name;
          existing.protocolVersion = parseIntSafe(record.txt.v, 1);
          existing.width = parseIntSafe(record.txt.w, 0);
          existing.height = parseIntSafe(record.txt.h, 0);
          existing.scale = parseIntSafe(record.txt.s, 1);
          existing.contentTypes = parseIntSafe(record.txt.cap, existing.contentTypes || 0);
          existing.wsPath = wsPath;
          existing.wsSecure = false;
          existing.maxMessageBytes = existing.maxMessageBytes || DEFAULT_WS_MAX_MESSAGE_BYTES;
          existing.unreachable = false;
          existing.lastSeenAt = now;
          this.ensureConnectionJob(existing);
          continue;
        }

        const managed: ManagedScreen = {
          id: fingerprint,
          intake: "bonjour",
          instanceName: record.instanceName,
          host: normalizeAddressHost(record.host),
          port: record.port,
          name,
          protocolVersion: parseIntSafe(record.txt.v, 1),
          width: parseIntSafe(record.txt.w, 0),
          height: parseIntSafe(record.txt.h, 0),
          scale: parseIntSafe(record.txt.s, 1),
          contentTypes: parseIntSafe(record.txt.cap, 0),
          fingerprint,
          lastSeenAt: now,
          wsPath,
          wsSecure: false,
          maxMessageBytes: DEFAULT_WS_MAX_MESSAGE_BYTES,
          currentRevision: 0,
          currentContentId: null,
          currentContentType: null,
          consecutiveFailures: 0,
          unreachable: false,
          sessionToken: null,
          eventBuffer: createEventBuffer(),
          wireMode: "content",
        };
        this.screensById.set(fingerprint, managed);
        this.ensureConnectionJob(managed);
      }

      for (const screen of this.screensById.values()) {
        if (screen.intake !== "bonjour") {
          continue;
        }
        if (seenFingerprints.has(screen.fingerprint)) {
          continue;
        }
        this.stopConnectionJob(screen);
      }

      await this.persistScreenState();
    } catch (err) {
      this.logger.warn?.(`[clawline:surf-ace] discovery_failed: ${String(err)}`);
    } finally {
      this.discoveryInFlight = false;
    }
  }

  private resolveScreenByFingerprint(input: string): ManagedScreen {
    const fingerprint = normalizeFingerprint(input);
    if (!fingerprint) {
      throw buildToolError("screen_not_found", `surf_ace screen_not_found: ${input}`);
    }
    const screen = this.screensById.get(fingerprint);
    if (!screen) {
      throw buildToolError("screen_not_found", `surf_ace screen_not_found: ${input}`);
    }
    return screen;
  }

  private requireConnected(screen: ManagedScreen): void {
    const state = this.socketStateFor(screen.id);
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN || !state.paired) {
      throw buildToolError("not_connected", `surf_ace not_connected: ${screen.fingerprint}`);
    }
  }

  private isSupportedContentType(screen: ManagedScreen, contentType: string): boolean {
    const bit = contentTypeMaskFor(contentType);
    if (!bit) {
      return false;
    }
    if (!screen.contentTypes) {
      return true;
    }
    return (screen.contentTypes & bit) === bit;
  }

  private encodeContentPayload(contentType: string, content: string): Record<string, unknown> {
    switch (contentType) {
      case "html":
        return { html: content };
      case "image":
        return { data: content, mediaType: "image/png" };
      case "pdf":
        return { data: content };
      case "terminal": {
        const lines = content.split(/\r?\n/);
        return { lines, scrollback: 0 };
      }
      case "markdown":
        return { markdown: content };
      case "video":
        return { url: content };
      case "canvas": {
        const trimmed = content.trim();
        if (!trimmed) {
          return {};
        }
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("canvas content must be a JSON object");
          }
          // TODO(surf-ace:v2-open-questions): canvas payload semantics are intentionally minimal
          // until Appendix A decisions land.
          return parsed as Record<string, unknown>;
        } catch (err) {
          throw buildToolError(
            "internal_error",
            `surf_ace_push failed (invalid_canvas_payload): ${String(err)}`,
          );
        }
      }
      default:
        throw buildToolError(
          "unsupported_content_type",
          `surf_ace_push failed (unsupported_content_type): ${contentType}`,
        );
    }
  }

  private normalizeToolError(
    err: unknown,
    fallbackCode: SurfAceToolErrorCode,
    prefix: string,
  ): ToolError {
    if (isToolError(err)) {
      return err;
    }
    if (err instanceof Error) {
      return buildToolError(fallbackCode, `${prefix}: ${err.message}`);
    }
    return buildToolError(fallbackCode, `${prefix}: unknown error`);
  }

  private async loadScreenState(): Promise<void> {
    this.screensById.clear();
    let clearedLegacySessionToken = false;
    let raw: string;
    try {
      raw = await fs.readFile(this.screenStatePath, "utf8");
    } catch {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.warn?.(`[clawline:surf-ace] screen_state_parse_failed: ${String(err)}`);
      return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }

    const file = parsed as { version?: unknown; providerId?: unknown; screens?: unknown };
    const screensRaw = Array.isArray(file.screens) ? file.screens : [];
    if (typeof file.providerId === "string" && file.providerId.trim().length > 0) {
      this.providerId = file.providerId.trim();
    }

    for (const entryRaw of screensRaw) {
      if (!entryRaw || typeof entryRaw !== "object" || Array.isArray(entryRaw)) {
        continue;
      }
      const entry = entryRaw as PersistedScreenStateEntry;
      const fingerprint = normalizeFingerprint(entry.fingerprint);
      const host = typeof entry.host === "string" ? normalizeAddressHost(entry.host) : "";
      const rawPort = Number(entry.port);
      const port = Number.isFinite(rawPort) ? Math.floor(rawPort) : 0;
      if (!fingerprint || !host || port <= 0) {
        continue;
      }

      const tokenRaw = typeof entry.sessionToken === "string" ? entry.sessionToken.trim() : "";
      const sessionToken = normalizeValidSessionId(tokenRaw);
      if (tokenRaw && sessionToken === null) {
        clearedLegacySessionToken = true;
      }

      const name =
        typeof entry.name === "string" && entry.name.trim().length > 0 ? entry.name : fingerprint;

      const managed: ManagedScreen = {
        id: fingerprint,
        intake: entry.intake === "manual" ? "manual" : "bonjour",
        instanceName: name,
        host,
        port,
        name,
        protocolVersion:
          entry.protocolVersion && Number.isFinite(entry.protocolVersion)
            ? Math.floor(entry.protocolVersion)
            : 1,
        width: entry.width && Number.isFinite(entry.width) ? Math.floor(entry.width) : 0,
        height: entry.height && Number.isFinite(entry.height) ? Math.floor(entry.height) : 0,
        scale: entry.scale && Number.isFinite(entry.scale) ? Math.floor(entry.scale) : 1,
        contentTypes:
          entry.contentTypes && Number.isFinite(entry.contentTypes)
            ? Math.floor(entry.contentTypes)
            : 0,
        fingerprint,
        lastSeenAt:
          typeof entry.lastSeenAt === "number" && Number.isFinite(entry.lastSeenAt)
            ? entry.lastSeenAt
            : this.now(),
        wsPath: normalizeWsPath(entry.wsPath),
        wsSecure: false,
        maxMessageBytes: DEFAULT_WS_MAX_MESSAGE_BYTES,
        currentRevision:
          typeof entry.currentRevision === "number" && Number.isFinite(entry.currentRevision)
            ? Math.floor(entry.currentRevision)
            : 0,
        currentContentId:
          typeof entry.currentContentId === "string" ? entry.currentContentId : null,
        currentContentType:
          typeof entry.currentContentType === "string" ? entry.currentContentType : null,
        consecutiveFailures: 0,
        unreachable: true,
        sessionToken,
        eventBuffer: createEventBuffer(),
        wireMode: "content",
      };

      this.screensById.set(fingerprint, managed);
    }

    if (clearedLegacySessionToken) {
      await this.persistScreenState();
    }
  }

  private async persistScreenState(): Promise<void> {
    const payload: ScreenStateFile = {
      version: 2,
      providerId: this.providerId,
      screens: Array.from(this.screensById.values())
        .toSorted((a, b) =>
          a.fingerprint.localeCompare(b.fingerprint, "en", { sensitivity: "base" }),
        )
        .map((screen) => ({
          fingerprint: screen.fingerprint,
          host: screen.host,
          port: screen.port,
          name: screen.name,
          intake: screen.intake,
          wsPath: screen.wsPath,
          wsSecure: screen.wsSecure,
          protocolVersion: screen.protocolVersion,
          width: screen.width,
          height: screen.height,
          scale: screen.scale,
          contentTypes: screen.contentTypes,
          sessionToken: screen.sessionToken,
          currentContentId: screen.currentContentId,
          currentRevision: screen.currentRevision,
          currentContentType: screen.currentContentType,
          lastSeenAt: screen.lastSeenAt,
        })),
    };

    this.screenStateWrite = this.screenStateWrite
      .catch(() => {})
      .then(async () => {
        await fs.writeFile(this.screenStatePath, JSON.stringify(payload, null, 2));
      })
      .catch((err) => {
        this.logger.warn?.(`[clawline:surf-ace] persist_screen_state_failed: ${String(err)}`);
      });

    await this.screenStateWrite;
  }

  private toPublicScreen(screen: ManagedScreen): SurfAceListScreen {
    const state = this.socketStateFor(screen.id);
    let connectionState: SurfAceConnectionState = "connecting";
    if (state.ws && state.ws.readyState === WebSocket.OPEN && state.paired) {
      connectionState = "connected";
    } else if (screen.unreachable) {
      connectionState = "unreachable";
    }

    return {
      name: screen.name,
      fingerprint: screen.fingerprint,
      lastSeenAt: screen.lastSeenAt,
      connectionState,
      viewport: {
        width: screen.width,
        height: screen.height,
        scale: screen.scale,
      },
      activeContent:
        screen.currentContentId && screen.currentContentType
          ? {
              contentId: screen.currentContentId,
              contentType: screen.currentContentType,
              revision: screen.currentRevision,
            }
          : null,
      pendingEvents: screen.eventBuffer.pendingEvents,
    };
  }
}

export function createSurfAceManager(options: SurfAceManagerOptions): SurfAceRuntime {
  return new SurfAceManager(options);
}
