import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { Logger } from "./domain.js";
import { runCommandWithTimeout } from "../process/exec.js";

const SURF_ACE_SERVICE_TYPE = "_surf-ace._tcp";
const TRUST_STORE_FILE = "surf-ace-trust.json";
const SCREEN_STATE_FILE = "surf-ace-screens.json";
const DEFAULT_DISCOVERY_INTERVAL_MS = 5_000;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 1_500;
const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
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
  intake: "bonjour";
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
  setCallbackBaseUrl(url: string): void;
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
  handleInboundEvent(params: {
    screenId: string;
    payload: unknown;
    remoteAddress?: string;
  }): SurfAceInboundEventResult;
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
  sessionToken: string | null;
  watchEnabled: boolean;
};

type ScreenStateFile = {
  version: 1;
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
  fetchImpl?: typeof fetch;
  discoverImpl?: (timeoutMs: number) => Promise<DiscoveryRecord[]>;
  now?: () => number;
};

type ManagedScreen = SurfAceDiscoveredScreen & {
  consecutiveFailures: number;
  unreachable: boolean;
  eventSourceAddress: string | null;
  watcherSessionKey: string | null;
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
      const tokens = line.split(/\s+/).filter((entry) => entry.includes("="));
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

function isIpAddress(value: string): boolean {
  return net.isIP(value) !== 0;
}

async function resolveExpectedSourceAddress(host: string): Promise<string | null> {
  const normalizedHost = normalizeAddressHost(host);
  if (isIpAddress(normalizedHost)) {
    return normalizedHost;
  }
  try {
    const resolved = await lookup(normalizedHost);
    return normalizeAddressHost(resolved.address);
  } catch {
    return null;
  }
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

class SurfAceManager implements SurfAceRuntime {
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly discoverImpl: (timeoutMs: number) => Promise<DiscoveryRecord[]>;
  private readonly now: () => number;
  private readonly trustStorePath: string;
  private readonly screenStatePath: string;
  private readonly discoveryIntervalMs: number;
  private readonly discoveryTimeoutMs: number;
  private readonly screensById = new Map<string, ManagedScreen>();
  private readonly trustByFingerprint = new Map<string, TrustedScreen>();
  private callbackBaseUrl: string | null = null;
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private discoveryInFlight = false;
  private screenStateWrite: Promise<void> = Promise.resolve();

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
  }

  async start(): Promise<void> {
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
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
  }

  setCallbackBaseUrl(url: string): void {
    this.callbackBaseUrl = url.trim().replace(/\/$/, "");
  }

  listScreens(): SurfAceDiscoveredScreen[] {
    return Array.from(this.screensById.values()).map((screen) => this.toPublicScreen(screen));
  }

  async pair(params: { userId: string | null; screen: string }): Promise<SurfAcePairResult> {
    const screen = this.resolveUniqueScreen(params.screen);
    const body: Record<string, unknown> = { mode: "auto" };

    screen.status = "pairing";
    try {
      const response = await this.requestScreen({
        screen,
        pathName: "/pair",
        method: "POST",
        body,
      });

      if (response.status === 409) {
        screen.status = "busy";
        screen.busy = true;
        throw new Error(`Screen "${screen.name}" is busy.`);
      }

      const payload = response.json;
      const sessionToken =
        payload && typeof payload.sessionToken === "string" ? payload.sessionToken.trim() : "";
      if (!sessionToken) {
        throw new Error(`Screen "${screen.name}" did not return a session token.`);
      }

      screen.sessionToken = sessionToken;
      screen.status = "paired";
      screen.busy = true;
      screen.unreachable = false;
      screen.consecutiveFailures = 0;

      this.trustByFingerprint.set(screen.fingerprint, {
        fingerprint: screen.fingerprint,
        displayName: screen.name,
        trustedAt: this.now(),
      });
      await this.persistTrustStore();
      await this.persistScreenState();

      return {
        ok: true,
        status: "paired",
        screen: this.toPublicScreen(screen),
      };
    } catch (err) {
      if (screen.status === "pairing") {
        screen.status = screen.busy ? "busy" : "discovered";
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
    const token = this.requireSessionToken(screen);

    const frameId = params.frameId?.trim() || buildFrameId();
    const body: Record<string, unknown> = {
      frameId,
      contentType: params.contentType,
      content: params.content,
    };
    if (typeof params.title === "string" && params.title.trim().length > 0) {
      body.title = params.title.trim();
    }

    const response = await this.requestScreen({
      screen,
      pathName: "/frame",
      method: "POST",
      body,
      authToken: token,
    });

    if (response.status === 422) {
      const errorMessage =
        response.json && typeof response.json.error === "object"
          ? (response.json.error as { message?: unknown }).message
          : undefined;
      const message =
        typeof errorMessage === "string" && errorMessage.trim().length > 0
          ? errorMessage
          : "render_failed";
      throw new Error(`Surf Ace push failed: ${message}`);
    }

    screen.sourceRef = params.sourceRef ?? null;
    screen.lastSnapshot = null;

    return {
      ok: true,
      screen: this.toPublicScreen(screen),
      frameId,
    };
  }

  async clear(params: { userId: string | null; screen: string }): Promise<SurfAceClearResult> {
    const screen = this.resolveUniqueScreen(params.screen);
    const token = this.requireSessionToken(screen);

    await this.requestScreen({
      screen,
      pathName: "/frame",
      method: "DELETE",
      authToken: token,
      allowNoJson: true,
    });

    screen.status = screen.busy ? "busy" : "paired";
    screen.sourceRef = null;
    screen.lastSnapshot = null;
    await this.persistScreenState();

    return {
      ok: true,
      screen: this.toPublicScreen(screen),
    };
  }

  async snapshot(params: {
    userId: string | null;
    screen?: string;
  }): Promise<SurfAceSnapshotResult[] | SurfAceSnapshotResult> {
    if (params.screen) {
      const screen = this.resolveUniqueScreen(params.screen);
      return await this.snapshotForScreen(screen);
    }

    const eligible = Array.from(this.screensById.values()).filter((screen) => {
      return Boolean(screen.sessionToken);
    });

    const results: SurfAceSnapshotResult[] = [];
    for (const screen of eligible) {
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
    const token = this.requireSessionToken(screen);

    if (params.enabled) {
      if (!this.callbackBaseUrl) {
        throw new Error("Surf Ace callback URL is not configured.");
      }
      const callbackUrl = `${this.callbackBaseUrl}/surf-ace/events/${encodeURIComponent(screen.id)}`;
      const body: Record<string, unknown> = { callbackUrl };
      if (params.debounce && Object.keys(params.debounce).length > 0) {
        body.debounce = params.debounce;
      }
      await this.requestScreen({
        screen,
        pathName: "/watch",
        method: "POST",
        authToken: token,
        body,
      });
      screen.watchEnabled = true;
      const watcherSessionKey = params.watcherSessionKey?.trim();
      screen.watcherSessionKey = watcherSessionKey ? watcherSessionKey : null;
    } else {
      await this.requestScreen({
        screen,
        pathName: "/unwatch",
        method: "POST",
        authToken: token,
        allowNoJson: true,
      });
      screen.watchEnabled = false;
      screen.watcherSessionKey = null;
    }
    await this.persistScreenState();

    return {
      ok: true,
      screen: this.toPublicScreen(screen),
      enabled: screen.watchEnabled,
    };
  }

  handleInboundEvent(params: {
    screenId: string;
    payload: unknown;
    remoteAddress?: string;
  }): SurfAceInboundEventResult {
    const screenId = decodeURIComponent(params.screenId.trim());
    const screen = this.screensById.get(screenId);
    if (!screen) {
      return { statusCode: 404, body: { ok: false, error: "unknown_screen" } };
    }
    if (!screen.watchEnabled) {
      return { statusCode: 409, body: { ok: false, error: "watch_not_enabled" } };
    }

    const expectedSource = screen.eventSourceAddress;
    const actualSource = params.remoteAddress ? normalizeAddressHost(params.remoteAddress) : null;
    if (!expectedSource || !actualSource || expectedSource !== actualSource) {
      return { statusCode: 403, body: { ok: false, error: "source_mismatch" } };
    }

    if (!params.payload || typeof params.payload !== "object" || Array.isArray(params.payload)) {
      return { statusCode: 400, body: { ok: false, error: "invalid_event" } };
    }

    screen.lastEvent = params.payload as Record<string, unknown>;
    void this.postWatcherAlert(screen, screen.lastEvent);
    return { statusCode: 200, body: { ok: true } };
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
      const snap = await this.snapshotForScreen(screen);
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

  private async snapshotForScreen(screen: ManagedScreen): Promise<SurfAceSnapshotResult> {
    const token = this.requireSessionToken(screen);
    const response = await this.requestScreen({
      screen,
      pathName: "/snapshot",
      method: "GET",
      authToken: token,
    });

    if (response.status === 204 || !response.json) {
      screen.lastSnapshot = null;
      return {
        ok: true,
        status: "no_content",
        screen: this.toPublicScreen(screen),
      };
    }

    screen.lastSnapshot = response.json;
    return {
      ok: true,
      status: "snapshot",
      screen: this.toPublicScreen(screen),
      snapshot: response.json,
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
        const resolvedSourceAddress =
          (await resolveExpectedSourceAddress(record.host)) ?? existing?.eventSourceAddress ?? null;
        const merged: ManagedScreen = {
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
          busy: record.txt.busy === "1",
          fingerprint,
          status:
            record.txt.busy === "1" ? "busy" : existing?.sessionToken ? "paired" : "discovered",
          sessionToken: existing?.sessionToken ?? null,
          sourceRef: existing?.sourceRef ?? null,
          watchEnabled: existing?.watchEnabled ?? false,
          lastSnapshot: existing?.lastSnapshot ?? null,
          lastEvent: existing?.lastEvent ?? null,
          consecutiveFailures: existing?.consecutiveFailures ?? 0,
          unreachable: false,
          eventSourceAddress: resolvedSourceAddress,
          watcherSessionKey: existing?.watcherSessionKey ?? null,
        };

        this.screensById.set(fingerprint, merged);
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
      if (screen.busy || screen.sessionToken) {
        continue;
      }
      if (!this.trustByFingerprint.has(screen.fingerprint)) {
        continue;
      }
      try {
        await this.pair({ userId: null, screen: screen.id });
      } catch {
        // Best effort: stay in discovered state.
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

  private async requestScreen(params: {
    screen: ManagedScreen;
    pathName: string;
    method: "GET" | "POST" | "DELETE";
    body?: Record<string, unknown>;
    authToken?: string;
    allowNoJson?: boolean;
    allowedStatuses?: number[];
  }): Promise<{ status: number; json: Record<string, unknown> | null }> {
    const url = `http://${params.screen.host}:${params.screen.port}${params.pathName}`;
    const headers: Record<string, string> = {};
    if (params.authToken) {
      headers.Authorization = `Bearer ${params.authToken}`;
    }
    if (params.body) {
      headers["content-type"] = "application/json";
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_HTTP_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        method: params.method,
        headers,
        body: params.body ? JSON.stringify(params.body) : undefined,
        signal: controller.signal,
      });

      const allowedStatuses = new Set([204, 409, 422, ...(params.allowedStatuses ?? [])]);
      if (!response.ok && !allowedStatuses.has(response.status)) {
        const bodyText = await response.text().catch(() => "");
        throw new Error(`Surf Ace HTTP ${response.status} at ${params.pathName}: ${bodyText}`);
      }

      let json: Record<string, unknown> | null = null;
      if (response.status !== 204 && !params.allowNoJson) {
        const text = await response.text();
        if (text.trim().length > 0) {
          json = JSON.parse(text) as Record<string, unknown>;
        }
      }

      params.screen.consecutiveFailures = 0;
      params.screen.unreachable = false;
      return {
        status: response.status,
        json,
      };
    } catch (err) {
      params.screen.consecutiveFailures += 1;
      if (params.screen.consecutiveFailures >= 3) {
        params.screen.unreachable = true;
      }
      throw err;
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
      // Silently fall back when alert forwarding is unavailable.
    }
  }

  private invalidateScreenSession(screen: ManagedScreen): void {
    screen.sessionToken = null;
    screen.watchEnabled = false;
    screen.status = "discovered";
    screen.busy = false;
    screen.sourceRef = null;
    screen.lastSnapshot = null;
    screen.watcherSessionKey = null;
  }

  private async rearmWatch(screen: ManagedScreen, authToken: string): Promise<boolean> {
    if (!this.callbackBaseUrl) {
      return false;
    }
    const callbackUrl = `${this.callbackBaseUrl}/surf-ace/events/${encodeURIComponent(screen.id)}`;
    const response = await this.requestScreen({
      screen,
      pathName: "/watch",
      method: "POST",
      authToken,
      body: { callbackUrl },
      allowedStatuses: [401, 403],
    });
    if (response.status === 401 || response.status === 403) {
      this.invalidateScreenSession(screen);
      return false;
    }
    return true;
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
        const token = screen.sessionToken?.trim();
        if (!token) {
          this.invalidateScreenSession(screen);
          return;
        }
        try {
          const response = await this.requestScreen({
            screen,
            pathName: "/snapshot",
            method: "GET",
            authToken: token,
            allowNoJson: true,
            allowedStatuses: [401, 403],
          });
          if (response.status === 401 || response.status === 403) {
            this.invalidateScreenSession(screen);
            return;
          }
          screen.status = "paired";
          screen.busy = true;
          if (screen.watchEnabled) {
            const rearmed = await this.rearmWatch(screen, token);
            screen.watchEnabled = rearmed;
          }
        } catch (err) {
          this.logger.warn?.(
            `[clawline:surf-ace] reconnect_failed(${screen.name}): ${String(err)}`,
          );
        }
      }),
    );
    await this.persistScreenState();
  }

  private async loadScreenState(): Promise<void> {
    this.screensById.clear();
    let raw: string;
    try {
      raw = await fs.readFile(this.screenStatePath, "utf8");
    } catch {
      return;
    }

    let parsed: ScreenStateFile;
    try {
      parsed = JSON.parse(raw) as ScreenStateFile;
    } catch (err) {
      this.logger.warn?.(`[clawline:surf-ace] screen_state_parse_failed: ${String(err)}`);
      return;
    }

    if (parsed.version !== 1 || !Array.isArray(parsed.screens)) {
      return;
    }

    for (const entry of parsed.screens) {
      const fingerprint = normalizeFingerprint(entry?.fingerprint);
      const host = typeof entry?.host === "string" ? entry.host.trim() : "";
      const rawPort = Number(entry?.port);
      const port = Number.isFinite(rawPort) ? Math.floor(rawPort) : 0;
      if (!fingerprint || !host || port <= 0) {
        continue;
      }

      const tokenRaw = typeof entry.sessionToken === "string" ? entry.sessionToken.trim() : "";
      const sessionToken = tokenRaw.length > 0 ? tokenRaw : null;
      const name = fingerprint;
      const instanceName = fingerprint;
      const eventSourceAddress = await resolveExpectedSourceAddress(host);
      const managed: ManagedScreen = {
        id: fingerprint,
        intake: "bonjour",
        instanceName,
        host,
        port,
        name,
        protocolVersion: 1,
        width: 0,
        height: 0,
        scale: 1,
        contentTypes: 0,
        busy: Boolean(sessionToken),
        fingerprint,
        status: sessionToken ? "paired" : "discovered",
        sessionToken,
        sourceRef: null,
        watchEnabled: Boolean(entry.watchEnabled && sessionToken),
        lastSnapshot: null,
        lastEvent: null,
        consecutiveFailures: 0,
        unreachable: false,
        eventSourceAddress,
        watcherSessionKey: null,
      };
      this.screensById.set(fingerprint, managed);
    }
  }

  private async persistScreenState(): Promise<void> {
    const payload: ScreenStateFile = {
      version: 1,
      screens: Array.from(this.screensById.values())
        .toSorted((a, b) =>
          a.fingerprint.localeCompare(b.fingerprint, "en", { sensitivity: "base" }),
        )
        .map((screen) => ({
          fingerprint: screen.fingerprint,
          host: screen.host,
          port: screen.port,
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
