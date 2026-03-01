import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";
import { runCommandWithTimeout } from "../process/exec.js";
import type { Logger } from "./domain.js";

const SURF_ACE_SERVICE_TYPE = "_surf-ace._tcp";
const TRUST_STORE_FILE = "surf-ace-trust.json";
const SCREEN_STATE_FILE = "surf-ace-screens.json";
const DEFAULT_DISCOVERY_INTERVAL_MS = 5_000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 1_500;
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
const DEFAULT_WS_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_WS_REQUEST_TIMEOUT_MS = 10_000;
const PAIR_RESPONSE_TIMEOUT_MS = 10_000;
const DEFAULT_WS_MAX_MESSAGE_BYTES = 12 * 1024 * 1024;
const SURF_ACE_SESSION_ID_PATTERN = /^sa_[A-Za-z0-9._:-]{8,128}$/;
const WS_HEARTBEAT_INTERVAL_MS = 10_000;
const WS_HEARTBEAT_TIMEOUT_MS = 3_000;
const WS_MAX_CONSECUTIVE_MISSED_PONGS = 2;
const WS_RECONNECT_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
const MAX_PROMPT_VISIBLE_TEXT_CHARS = 4_096;

export type SurfAceScreenStatus = "discovered" | "pairing" | "paired" | "busy";

export type SurfAceSourceRef = {
  sessionKey: string;
  messageId: string;
};

export type SurfAceDiscoveredScreen = {
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
  busy: boolean;
  fingerprint: string;
  status: SurfAceScreenStatus;
  intake: "bonjour" | "manual";
  sessionToken: string | null;
  sourceRef: SurfAceSourceRef | null;
  watchEnabled: boolean;
  lastSnapshot: Record<string, unknown> | null;
  lastEvent: Record<string, unknown> | null;
};

export type SurfAceSnapshotResult =
  | {
      ok: true;
      status: "snapshot";
      screen: SurfAceDiscoveredScreen;
      snapshot: Record<string, unknown>;
    }
  | {
      ok: true;
      status: "no_content";
      screen: SurfAceDiscoveredScreen;
    };

export type SurfAceWatchDebounce = Partial<{
  scroll_settle: number;
  zoom_settle: number;
  text_selected: number;
  point: number;
  region: number;
  page_change: number;
}>;

export type SurfAcePairResult = {
  ok: true;
  status: "paired";
  screen: SurfAceDiscoveredScreen;
};

export type SurfAceRegisterResult = {
  ok: true;
  screen: SurfAceDiscoveredScreen;
};

export type SurfAcePushResult = {
  ok: true;
  screen: SurfAceDiscoveredScreen;
  frameId: string;
};

export type SurfAceClearResult = {
  ok: true;
  screen: SurfAceDiscoveredScreen;
};

export type SurfAceWatchResult = {
  ok: true;
  screen: SurfAceDiscoveredScreen;
  enabled: boolean;
};

export type SurfAceInboundEventResult = {
  statusCode: number;
  body: { ok: boolean; error?: string };
};

export interface SurfAceRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  register(params: { userId: string | null; url: string }): Promise<SurfAceRegisterResult>;
  pair(params: { userId: string | null; screen: string }): Promise<SurfAcePairResult>;
  push(params: {
    userId: string | null;
    screen: string;
    contentType: string;
    content: Record<string, unknown>;
    title?: string;
    sourceRef?: SurfAceSourceRef;
    frameId?: string;
  }): Promise<SurfAcePushResult>;
  clear(params: { userId: string | null; screen: string }): Promise<SurfAceClearResult>;
  snapshot(params: {
    userId: string | null;
    screen?: string;
  }): Promise<SurfAceSnapshotResult[] | SurfAceSnapshotResult>;
  watch(params: {
    userId: string | null;
    screen: string;
    enabled: boolean;
    debounce?: SurfAceWatchDebounce;
    watcherSessionKey?: string;
  }): Promise<SurfAceWatchResult>;
  buildContextInjection(params: { userId: string }): Promise<string | null>;
  listScreens(): SurfAceDiscoveredScreen[];
}

type TrustedScreen = {
  fingerprint: string;
  publicKey?: string;
  displayName: string;
  trustedAt: number;
};

type TrustStoreFile = {
  version: 1;
  entries: TrustedScreen[];
};

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
  watchEnabled: boolean;
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

type ManagedScreen = SurfAceDiscoveredScreen & {
  wsPath: string;
  wsSecure: boolean;
  maxMessageBytes: number;
  currentRevision: number;
  currentFrameId: string | null;
  consecutiveFailures: number;
  unreachable: boolean;
  watcherSessionKey: string | null;
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

function parseScreenBaseUrl(rawUrl: string): URL {
  const candidate = rawUrl.trim();
  if (!candidate) {
    throw new Error("url is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch (err) {
    throw new Error(`Invalid Surf Ace URL: ${String(err)}`, { cause: err });
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "ws:") {
    throw new Error("Surf Ace register URL must use http:// or ws://");
  }
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  if (!parsed.pathname || parsed.pathname === "/") {
    parsed.pathname = "/ws";
  }
  return parsed;
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

function parseOptionalBusy(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value === 1 ? true : value === 0 ? false : undefined;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "1" || normalized === "true") {
      return true;
    }
    if (normalized === "0" || normalized === "false") {
      return false;
    }
  }
  return undefined;
}

function truncatePromptText(value: string, maxBytes: number): string {
  const trimmed = value.trim();
  if (Buffer.byteLength(trimmed, "utf8") <= maxBytes) {
    return trimmed;
  }
  const byteBudget = Math.max(0, maxBytes - 3);
  let out = trimmed;
  while (out.length > 0 && Buffer.byteLength(out, "utf8") > byteBudget) {
    out = out.slice(0, -1);
  }
  return `${out}...`;
}

function buildFrameId(): string {
  return `fr_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
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
      default:
        break;
    }
  }
  return mask;
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

function deriveScreenFingerprint(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

function normalizeValidSessionId(value: string | null | undefined): string | null {
  const token = value?.trim() ?? "";
  if (!token) {
    return null;
  }
  return SURF_ACE_SESSION_ID_PATTERN.test(token) ? token : null;
}

function stripCssNoiseFromVisibleText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (!/^(?:[\w.#][\w.]*)\s*\{/.test(trimmed)) {
    return trimmed;
  }
  return trimmed.replace(/^([\w.#][\w.]*\s*\{[^}]*\}\s*)+/, "").trim();
}

class SurfAceManager implements SurfAceRuntime {
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly discoverImpl: (timeoutMs: number) => Promise<DiscoveryRecord[]>;
  private readonly now: () => number;
  private readonly trustStorePath: string;
  private readonly screenStatePath: string;
  private readonly discoveryIntervalMs: number;
  private readonly discoveryTimeoutMs: number;
  private readonly wsConnectTimeoutMs: number;
  private readonly wsRequestTimeoutMs: number;
  private readonly wsHeartbeatIntervalMs: number;
  private readonly wsHeartbeatTimeoutMs: number;
  private readonly wsReconnectBackoffMs: number[];
  private readonly screensById = new Map<string, ManagedScreen>();
  private readonly trustByFingerprint = new Map<string, TrustedScreen>();
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
    this.trustStorePath = path.join(options.statePath, TRUST_STORE_FILE);
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
    await this.loadTrustStore();
    await this.loadScreenState();
    await this.reconnectPersistedScreens();
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

  listScreens(): SurfAceDiscoveredScreen[] {
    return Array.from(this.screensById.values()).map((screen) => this.toPublicScreen(screen));
  }

  async register(params: { userId: string | null; url: string }): Promise<SurfAceRegisterResult> {
    const baseUrl = parseScreenBaseUrl(params.url);
    const host = normalizeAddressHost(baseUrl.hostname);
    const defaultPort = 80;
    const portRaw = baseUrl.port ? Number.parseInt(baseUrl.port, 10) : defaultPort;
    const port = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : defaultPort;
    const wsPath = normalizeWsPath(baseUrl.pathname);

    let identity: {
      fingerprint: string;
      name: string;
      protocolVersion?: number;
      width?: number;
      height?: number;
      scale?: number;
      contentTypes?: number;
      busy?: boolean;
    } | null = null;
    if (baseUrl.protocol === "http:") {
      try {
        identity = await this.fetchIdentity(baseUrl);
      } catch {
        identity = null;
      }
    }

    const identityFingerprint = normalizeFingerprint(identity?.fingerprint);
    const fallbackFingerprint = deriveScreenFingerprint(`${host}:${port}${wsPath}`);
    const fingerprint = identityFingerprint || fallbackFingerprint;
    const existing = this.screensById.get(fingerprint);
    const name =
      identity?.name?.trim() ||
      existing?.name ||
      (typeof identityFingerprint === "string" && identityFingerprint ? identityFingerprint : host);
    const busy = identity?.busy ?? existing?.busy ?? false;
    const status: SurfAceScreenStatus = existing?.sessionToken
      ? "paired"
      : busy
        ? "busy"
        : "discovered";

    const managed: ManagedScreen = existing ?? {
      id: fingerprint,
      intake: "manual",
      instanceName: name,
      host,
      port,
      name,
      protocolVersion: identity?.protocolVersion ?? 1,
      width: identity?.width ?? 0,
      height: identity?.height ?? 0,
      scale: identity?.scale ?? 1,
      contentTypes: identity?.contentTypes ?? 0,
      busy,
      fingerprint,
      status,
      sessionToken: null,
      sourceRef: null,
      watchEnabled: false,
      lastSnapshot: null,
      lastEvent: null,
      wsPath,
      wsSecure: false,
      maxMessageBytes: DEFAULT_WS_MAX_MESSAGE_BYTES,
      currentRevision: 0,
      currentFrameId: null,
      consecutiveFailures: 0,
      unreachable: false,
      watcherSessionKey: null,
    };

    managed.intake = "manual";
    managed.instanceName = name;
    managed.host = host;
    managed.port = port;
    managed.name = name;
    managed.protocolVersion = identity?.protocolVersion ?? managed.protocolVersion;
    managed.width = identity?.width ?? managed.width;
    managed.height = identity?.height ?? managed.height;
    managed.scale = identity?.scale ?? managed.scale;
    managed.contentTypes = identity?.contentTypes ?? managed.contentTypes;
    managed.busy = busy;
    managed.status = status;
    managed.wsPath = wsPath;
    managed.wsSecure = false;
    managed.maxMessageBytes = managed.maxMessageBytes || DEFAULT_WS_MAX_MESSAGE_BYTES;
    this.screensById.set(fingerprint, managed);

    await this.persistScreenState();
    return { ok: true, screen: this.toPublicScreen(managed) };
  }

  async pair(params: { userId: string | null; screen: string }): Promise<SurfAcePairResult> {
    const screen = this.resolveUniqueScreen(params.screen);
    screen.status = "pairing";
    try {
      await this.ensureScreenSocketPaired(screen, {
        forcePairRequest: true,
        isReconnect: false,
      });
      this.trustByFingerprint.set(screen.fingerprint, {
        fingerprint: screen.fingerprint,
        displayName: screen.name,
        trustedAt: this.now(),
      });
      await this.persistTrustStore();
      await this.persistScreenState();
      return { ok: true, status: "paired", screen: this.toPublicScreen(screen) };
    } catch (err) {
      if (screen.status === "pairing") {
        const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
        screen.status = code === "busy" ? "busy" : "discovered";
      }
      throw err;
    }
  }

  async push(params: {
    userId: string | null;
    screen: string;
    contentType: string;
    content: Record<string, unknown>;
    title?: string;
    sourceRef?: SurfAceSourceRef;
    frameId?: string;
  }): Promise<SurfAcePushResult> {
    const screen = this.resolveUniqueScreen(params.screen);
    this.requireSessionToken(screen);
    await this.ensureScreenSocketPaired(screen, { forcePairRequest: false, isReconnect: false });

    const frameId = params.frameId?.trim() || buildFrameId();
    const nextRevision = screen.currentRevision + 1;
    const payload: Record<string, unknown> = {
      frameId,
      revision: nextRevision,
      contentType: params.contentType,
      content: params.content,
    };
    if (typeof params.title === "string" && params.title.trim().length > 0) {
      payload.display = { title: params.title.trim() };
    }
    const response = await this.sendScreenRequest(screen, "frame.set", payload);
    const responsePayload = clampSnapshotToRecord(response.payload);
    const currentRevision = parseOptionalNumber(responsePayload.currentRevision);
    screen.currentRevision = currentRevision ?? nextRevision;
    screen.currentFrameId = frameId;
    screen.sourceRef = params.sourceRef ?? null;
    screen.lastSnapshot = null;
    await this.persistScreenState();
    return { ok: true, screen: this.toPublicScreen(screen), frameId };
  }

  async clear(params: { userId: string | null; screen: string }): Promise<SurfAceClearResult> {
    const screen = this.resolveUniqueScreen(params.screen);
    this.requireSessionToken(screen);
    await this.ensureScreenSocketPaired(screen, { forcePairRequest: false, isReconnect: false });

    const nextRevision = screen.currentRevision + 1;
    const response = await this.sendScreenRequest(screen, "frame.clear", {
      revision: nextRevision,
    });
    const payload = clampSnapshotToRecord(response.payload);
    const currentRevision = parseOptionalNumber(payload.currentRevision);
    screen.currentRevision = currentRevision ?? nextRevision;
    screen.currentFrameId = null;
    screen.sourceRef = null;
    screen.lastSnapshot = null;
    await this.persistScreenState();
    return { ok: true, screen: this.toPublicScreen(screen) };
  }

  async snapshot(params: {
    userId: string | null;
    screen?: string;
  }): Promise<SurfAceSnapshotResult[] | SurfAceSnapshotResult> {
    if (params.screen) {
      const screen = this.resolveUniqueScreen(params.screen);
      return await this.snapshotForScreen(screen);
    }
    const paired = Array.from(this.screensById.values()).filter((screen) =>
      Boolean(screen.sessionToken),
    );
    const results: SurfAceSnapshotResult[] = [];
    for (const screen of paired) {
      results.push(await this.snapshotForScreen(screen));
    }
    return results;
  }

  async watch(params: {
    userId: string | null;
    screen: string;
    enabled: boolean;
    debounce?: SurfAceWatchDebounce;
    watcherSessionKey?: string;
  }): Promise<SurfAceWatchResult> {
    const screen = this.resolveUniqueScreen(params.screen);
    screen.watchEnabled = params.enabled;
    const watcherSessionKey = params.watcherSessionKey?.trim();
    screen.watcherSessionKey = params.enabled && watcherSessionKey ? watcherSessionKey : null;
    await this.persistScreenState();
    return { ok: true, screen: this.toPublicScreen(screen), enabled: screen.watchEnabled };
  }

  async buildContextInjection(_params: { userId: string }): Promise<string | null> {
    const screens = Array.from(this.screensById.values()).toSorted((a, b) =>
      a.name.localeCompare(b.name, "en", { sensitivity: "base" }),
    );
    if (screens.length === 0) {
      return null;
    }
    const lines: string[] = ["## Surf Ace Screens"];
    for (const screen of screens) {
      const viewport = `${screen.width}x${screen.height}`;
      if (!screen.sessionToken) {
        const status = screen.busy ? "busy" : "available - not paired";
        lines.push(`- "${screen.name}" (${viewport}, ${status})`);
        continue;
      }
      let snap: SurfAceSnapshotResult;
      try {
        snap = await this.snapshotForScreen(screen);
      } catch {
        lines.push(`- "${screen.name}" (${viewport}, paired): unreachable`);
        continue;
      }
      if (snap.status === "no_content") {
        lines.push(`- "${screen.name}" (${viewport}, paired): connected, no frame`);
        continue;
      }
      const snapshot = snap.snapshot;
      const contentType =
        typeof snapshot.contentType === "string" && snapshot.contentType.trim()
          ? snapshot.contentType
          : "unknown";
      const title =
        typeof snapshot.title === "string" && snapshot.title.trim().length > 0
          ? snapshot.title.trim()
          : "Untitled";
      lines.push(`- "${screen.name}" (${viewport}, paired): showing ${contentType} "${title}"`);
      const visibleTextRaw = typeof snapshot.visibleText === "string" ? snapshot.visibleText : "";
      lines.push(
        `  visible: ${visibleTextRaw ? truncatePromptText(visibleTextRaw, MAX_PROMPT_VISIBLE_TEXT_CHARS) : "none"}`,
      );
      const selectionRaw = snapshot.selection;
      if (selectionRaw && typeof selectionRaw === "object") {
        const text =
          typeof (selectionRaw as { text?: unknown }).text === "string"
            ? (selectionRaw as { text: string }).text
            : JSON.stringify(selectionRaw);
        lines.push(`  selection: ${truncatePromptText(text, MAX_PROMPT_VISIBLE_TEXT_CHARS)}`);
      } else {
        lines.push("  selection: none");
      }
      if (screen.sourceRef) {
        lines.push(`  sourceRef: ${screen.sourceRef.sessionKey}#${screen.sourceRef.messageId}`);
      }
    }
    if (lines.length <= 1) {
      return null;
    }
    return `${lines.join("\n")}\n`;
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
    const text =
      typeof rawData === "string"
        ? rawData
        : Buffer.isBuffer(rawData)
          ? rawData.toString("utf8")
          : Array.isArray(rawData)
            ? Buffer.concat(rawData).toString("utf8")
            : Buffer.from(rawData).toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
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
      op !== "event.snapshot_hint"
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
    const eventPayload = {
      op: eventEnvelope.op,
      eventId: eventEnvelope.eventId,
      sentAt: eventEnvelope.sentAt,
      payload: eventEnvelope.payload ?? {},
    };
    screen.lastEvent = clampSnapshotToRecord(eventPayload);
    if (!screen.watchEnabled) {
      return;
    }
    void this.postWatcherAlert(screen, screen.lastEvent);
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
    screen.unreachable = true;
    screen.status = "paired";
    this.scheduleReconnect(screen, state);
  }

  private scheduleReconnect(screen: ManagedScreen, state: ScreenSocketState): void {
    if (state.reconnectTimer || this.stopping) {
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
        this.scheduleReconnect(screen, state);
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
      const currentFrameId =
        typeof statePayload.currentFrameId === "string" ? statePayload.currentFrameId : null;
      screen.currentRevision = currentRevision ?? screen.currentRevision;
      screen.currentFrameId = currentFrameId;
    } else {
      screen.currentRevision = 0;
      screen.currentFrameId = null;
    }
    screen.sessionToken = sessionId;
    screen.status = "paired";
    screen.busy = true;
    screen.unreachable = false;
    screen.consecutiveFailures = 0;
    state.paired = true;
    state.reconnectAttempt = 0;
    state.forceTakeoverOnNextPair = false;
    state.awaitingSnapshotAfterReconnect = false;
    state.bufferedEvents = [];
    this.startHeartbeat(screen, state);
    if (isReconnect) {
      try {
        state.awaitingSnapshotAfterReconnect = true;
        await this.snapshotForScreen(screen);
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
      throw new Error(`Surf Ace screen "${screen.name}" is disconnected.`);
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
        const err = new Error(`Surf Ace ${op} timed out.`);
        reject(err);
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
        response.error && typeof response.error.code === "string" ? response.error.code : "unknown";
      const message =
        response.error && typeof response.error.message === "string"
          ? response.error.message
          : `Surf Ace ${op} failed`;
      const err = new Error(`${message} (${code})`) as Error & { code?: string };
      err.code = code;
      throw err;
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

  private async snapshotForScreen(screen: ManagedScreen): Promise<SurfAceSnapshotResult> {
    this.requireSessionToken(screen);
    await this.ensureScreenSocketPaired(screen, { forcePairRequest: false, isReconnect: false });
    const response = await this.sendScreenRequest(screen, "snapshot.get", {
      includeVisibleText: true,
      includeDrawings: false,
    });
    const payload = clampSnapshotToRecord(response.payload);
    const visibleText = payload.visibleText;
    if (typeof visibleText === "string") {
      payload.visibleText = stripCssNoiseFromVisibleText(visibleText);
    }
    const frameId = typeof payload.frameId === "string" ? payload.frameId : null;
    const revision = parseOptionalNumber(payload.revision);
    if (revision !== undefined) {
      screen.currentRevision = revision;
    }
    screen.currentFrameId = frameId;
    if (!frameId) {
      screen.lastSnapshot = null;
      return { ok: true, status: "no_content", screen: this.toPublicScreen(screen) };
    }
    screen.lastSnapshot = payload;
    return {
      ok: true,
      status: "snapshot",
      screen: this.toPublicScreen(screen),
      snapshot: payload,
    };
  }

  private async refreshDiscovery(): Promise<void> {
    if (this.discoveryInFlight) {
      return;
    }
    this.discoveryInFlight = true;
    try {
      const discovered = await this.discoverImpl(this.discoveryTimeoutMs);
      for (const record of discovered) {
        const fingerprint = normalizeFingerprint(record.txt.pk);
        if (!fingerprint) {
          continue;
        }
        const existing = this.screensById.get(fingerprint);
        const name = normalizeScreenName(record);
        const busy = record.txt.busy === "1";
        const wsPath = normalizeWsPath(record.txt.ws);
        if (existing) {
          existing.intake = "bonjour";
          existing.instanceName = record.instanceName;
          existing.host = record.host;
          existing.port = record.port;
          existing.name = name;
          existing.protocolVersion = parseIntSafe(record.txt.v, 1);
          existing.width = parseIntSafe(record.txt.w, 0);
          existing.height = parseIntSafe(record.txt.h, 0);
          existing.scale = parseIntSafe(record.txt.s, 1);
          existing.contentTypes = parseIntSafe(record.txt.cap, 0);
          existing.wsPath = wsPath;
          existing.wsSecure = false;
          existing.maxMessageBytes = existing.maxMessageBytes || DEFAULT_WS_MAX_MESSAGE_BYTES;
          existing.busy = busy || Boolean(existing.sessionToken);
          existing.status = existing.sessionToken ? "paired" : busy ? "busy" : "discovered";
          existing.unreachable = false;
          continue;
        }
        const managed: ManagedScreen = {
          id: fingerprint,
          intake: "bonjour",
          instanceName: record.instanceName,
          host: record.host,
          port: record.port,
          name,
          protocolVersion: parseIntSafe(record.txt.v, 1),
          width: parseIntSafe(record.txt.w, 0),
          height: parseIntSafe(record.txt.h, 0),
          scale: parseIntSafe(record.txt.s, 1),
          contentTypes: parseIntSafe(record.txt.cap, 0),
          busy,
          fingerprint,
          status: busy ? "busy" : "discovered",
          sessionToken: null,
          sourceRef: null,
          watchEnabled: false,
          lastSnapshot: null,
          lastEvent: null,
          wsPath,
          wsSecure: false,
          maxMessageBytes: DEFAULT_WS_MAX_MESSAGE_BYTES,
          currentRevision: 0,
          currentFrameId: null,
          consecutiveFailures: 0,
          unreachable: false,
          watcherSessionKey: null,
        };
        this.screensById.set(fingerprint, managed);
      }
      await this.tryAutoPairTrustedScreens();
      await this.persistScreenState();
    } catch (err) {
      this.logger.warn?.(`[clawline:surf-ace] discovery_failed: ${String(err)}`);
    } finally {
      this.discoveryInFlight = false;
    }
  }

  private async tryAutoPairTrustedScreens(): Promise<void> {
    for (const screen of this.screensById.values()) {
      if (screen.sessionToken) {
        continue;
      }
      if (!this.trustByFingerprint.has(screen.fingerprint)) {
        continue;
      }
      try {
        await this.pair({ userId: null, screen: screen.id });
      } catch {
        // Best effort.
      }
    }
  }

  private resolveUniqueScreen(input: string): ManagedScreen {
    const target = input.trim();
    if (!target) {
      throw new Error("screen is required");
    }
    const lower = target.toLowerCase();
    const matches = Array.from(this.screensById.values()).filter((screen) => {
      return (
        screen.id.toLowerCase() === lower ||
        screen.fingerprint.toLowerCase() === lower ||
        screen.name.toLowerCase() === lower ||
        screen.instanceName.toLowerCase() === lower
      );
    });
    if (matches.length === 0) {
      throw new Error(`Surf Ace screen not found: ${target}`);
    }
    if (matches.length > 1) {
      const options = matches
        .map((entry) => `${entry.name} (${entry.fingerprint.slice(0, 4)})`)
        .join(", ");
      throw new Error(`Ambiguous Surf Ace screen "${target}". Choose one: ${options}`);
    }
    return matches[0];
  }

  private requireSessionToken(screen: ManagedScreen): string {
    const token = screen.sessionToken?.trim();
    if (!token) {
      throw new Error(`Surf Ace screen "${screen.name}" is not paired. Call surf_ace_pair first.`);
    }
    return token;
  }

  private async fetchIdentity(baseUrl: URL): Promise<{
    fingerprint: string;
    name: string;
    protocolVersion?: number;
    width?: number;
    height?: number;
    scale?: number;
    contentTypes?: number;
    busy?: boolean;
  }> {
    const identityUrl = new URL("/identity", baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_HTTP_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(identityUrl.toString(), {
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Surf Ace HTTP ${response.status} at /identity`);
      }
      const text = await response.text();
      if (!text.trim()) {
        throw new Error("Surf Ace identity response was empty.");
      }
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Surf Ace identity response must be an object.");
      }
      const identity = parsed as Record<string, unknown>;
      const screen =
        identity.screen && typeof identity.screen === "object" && !Array.isArray(identity.screen)
          ? (identity.screen as Record<string, unknown>)
          : null;
      const readField = (...keys: string[]): unknown => {
        for (const key of keys) {
          if (key in identity) {
            return identity[key];
          }
          if (screen && key in screen) {
            return screen[key];
          }
        }
        return undefined;
      };
      const fingerprintRaw = readField("fingerprint", "pk");
      const fingerprint = typeof fingerprintRaw === "string" ? fingerprintRaw.trim() : "";
      const nameRaw = readField("name", "displayName", "screenName", "instanceName");
      const name =
        typeof nameRaw === "string" && nameRaw.trim().length > 0
          ? nameRaw.trim()
          : fingerprint || "Surf Ace";
      return {
        fingerprint,
        name,
        protocolVersion: parseOptionalNumber(readField("protocolVersion", "v")),
        width: parseOptionalNumber(readField("width", "w")),
        height: parseOptionalNumber(readField("height", "h")),
        scale: parseOptionalNumber(readField("scale", "s")),
        contentTypes: parseOptionalNumber(readField("contentTypes", "cap")),
        busy: parseOptionalBusy(readField("busy")),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async postWatcherAlert(
    screen: ManagedScreen,
    eventPayload: Record<string, unknown>,
  ): Promise<void> {
    const watcherSessionKey = screen.watcherSessionKey?.trim();
    if (!watcherSessionKey) {
      return;
    }
    const messagePayload = {
      screenId: screen.id,
      screenName: screen.name,
      event: eventPayload,
    };
    const body = JSON.stringify({
      sessionKey: watcherSessionKey,
      message: JSON.stringify(messagePayload),
      noOverlay: true,
    });
    try {
      await this.fetchImpl("http://localhost:18800/alert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    } catch {
      // best effort
    }
  }

  private invalidateScreenSession(screen: ManagedScreen): void {
    const state = this.socketStateFor(screen.id);
    state.shouldReconnect = false;
    this.stopHeartbeat(state);
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    this.rejectAllPendingRequests(state, new Error("Surf Ace session invalidated"));
    try {
      state.ws?.close(1000, "provider_shutdown");
    } catch {
      // ignore
    }
    state.ws = null;
    state.paired = false;
    screen.sessionToken = null;
    screen.watchEnabled = false;
    screen.status = "discovered";
    screen.busy = false;
    screen.sourceRef = null;
    screen.lastSnapshot = null;
    screen.lastEvent = null;
    screen.currentRevision = 0;
    screen.currentFrameId = null;
    screen.watcherSessionKey = null;
  }

  private async reconnectPersistedScreens(): Promise<void> {
    const pairedScreens = Array.from(this.screensById.values()).filter((screen) =>
      Boolean(screen.sessionToken),
    );
    if (pairedScreens.length === 0) {
      return;
    }
    await Promise.all(
      pairedScreens.map(async (screen) => {
        try {
          await this.ensureScreenSocketPaired(screen, {
            forcePairRequest: true,
            isReconnect: true,
          });
        } catch (err) {
          this.logger.warn?.(
            `[clawline:surf-ace] reconnect_failed(${screen.name}): ${String(err)}`,
          );
          const state = this.socketStateFor(screen.id);
          state.shouldReconnect = true;
          this.scheduleReconnect(screen, state);
        }
      }),
    );
    await this.persistScreenState();
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
        busy: Boolean(sessionToken),
        fingerprint,
        status: sessionToken ? "paired" : "discovered",
        sessionToken,
        sourceRef: null,
        watchEnabled: Boolean(entry.watchEnabled && sessionToken),
        lastSnapshot: null,
        lastEvent: null,
        wsPath: normalizeWsPath(entry.wsPath),
        wsSecure: false,
        maxMessageBytes: DEFAULT_WS_MAX_MESSAGE_BYTES,
        currentRevision: 0,
        currentFrameId: null,
        consecutiveFailures: 0,
        unreachable: false,
        watcherSessionKey: null,
      };
      this.screensById.set(fingerprint, managed);
      const state = this.socketStateFor(fingerprint);
      state.shouldReconnect = Boolean(sessionToken);
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
          watchEnabled: screen.watchEnabled,
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

  private async loadTrustStore(): Promise<void> {
    this.trustByFingerprint.clear();
    try {
      const raw = await fs.readFile(this.trustStorePath, "utf8");
      const parsed = JSON.parse(raw) as TrustStoreFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
        return;
      }
      for (const entry of parsed.entries) {
        const fingerprint = normalizeFingerprint(entry.fingerprint);
        if (!fingerprint) {
          continue;
        }
        this.trustByFingerprint.set(fingerprint, {
          fingerprint,
          publicKey: typeof entry.publicKey === "string" ? entry.publicKey : undefined,
          displayName:
            typeof entry.displayName === "string" && entry.displayName.trim().length > 0
              ? entry.displayName.trim()
              : fingerprint,
          trustedAt:
            typeof entry.trustedAt === "number" && Number.isFinite(entry.trustedAt)
              ? entry.trustedAt
              : this.now(),
        });
      }
    } catch {
      // Missing trust store is expected on first run.
    }
  }

  private async persistTrustStore(): Promise<void> {
    const payload: TrustStoreFile = {
      version: 1,
      entries: Array.from(this.trustByFingerprint.values()).toSorted((a, b) =>
        a.fingerprint.localeCompare(b.fingerprint, "en", { sensitivity: "base" }),
      ),
    };
    await fs.writeFile(this.trustStorePath, JSON.stringify(payload, null, 2));
  }

  private toPublicScreen(screen: ManagedScreen): SurfAceDiscoveredScreen {
    return {
      id: screen.id,
      instanceName: screen.instanceName,
      host: screen.host,
      port: screen.port,
      name: screen.name,
      protocolVersion: screen.protocolVersion,
      width: screen.width,
      height: screen.height,
      scale: screen.scale,
      contentTypes: screen.contentTypes,
      busy: screen.busy,
      fingerprint: screen.fingerprint,
      status: screen.status,
      intake: screen.intake,
      sessionToken: screen.sessionToken,
      sourceRef: screen.sourceRef,
      watchEnabled: screen.watchEnabled,
      lastSnapshot: screen.lastSnapshot,
      lastEvent: screen.lastEvent,
    };
  }
}

export function createSurfAceManager(options: SurfAceManagerOptions): SurfAceRuntime {
  return new SurfAceManager(options);
}
