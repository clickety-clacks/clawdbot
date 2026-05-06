import { Blob } from "node:buffer";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import jwt from "jsonwebtoken";
import { FormData, fetch, getGlobalDispatcher } from "undici";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { getReplyFromConfig } from "../../../../src/auto-reply/reply.js";
import type { OpenClawConfig } from "../../../../src/config/config.js";
import { clawlineMessageActions } from "../actions.js";
import type {
  AllowlistEntry,
  ClawlineOutboundSendResult,
  Logger,
  ProviderConfig,
  ProviderServer,
} from "./domain.js";
import { setClawlineOutboundSender } from "./outbound.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

const gatewayCallMock = vi.fn();
const enqueueAnnounceMock = vi.fn();
const abortAgentHarnessRunMock = vi.fn();
const resolveActiveAgentHarnessRunSessionIdMock = vi.fn();
const loadModelCatalogMock = vi.fn();
const loadSessionStoreMock = vi.fn();
vi.mock("../runtime-api.js", async () => {
  const actual = await vi.importActual("../runtime-api.js");
  return {
    ...actual,
    abortAgentHarnessRun: (...args: unknown[]) => abortAgentHarnessRunMock(...args),
    resolveActiveAgentHarnessRunSessionId: (...args: unknown[]) =>
      resolveActiveAgentHarnessRunSessionIdMock(...args),
    enqueueAnnounce: (...args: unknown[]) => enqueueAnnounceMock(...args),
    loadSessionStore: (...args: unknown[]) => {
      loadSessionStoreMock(...args);
      return (
        actual as {
          loadSessionStore: (...innerArgs: unknown[]) => unknown;
        }
      ).loadSessionStore(...args);
    },
    loadModelCatalog: (...args: unknown[]) => loadModelCatalogMock(...args),
  };
});

vi.mock("./gateway-alert-runtime.js", () => ({
  callClawlineGatewayAgent: (...args: unknown[]) => gatewayCallMock(...args),
}));

const sendMessageMock = vi.fn();
vi.mock("../infra/outbound/message.js", () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));

import {
  createProviderServer,
  DEFAULT_ALERT_INSTRUCTIONS_TEXT,
  MAIN_SESSION_ALERT_REPLY_TEXT,
  PROTOCOL_VERSION,
} from "./server.js";

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const testReplyResolver: typeof getReplyFromConfig = async () => ({ text: "ok" });
const withMainAlertReplyRequirement = (text: string) =>
  `${text}\n\n${MAIN_SESSION_ALERT_REPLY_TEXT}`;

const testOpenClawConfig = {
  agents: { default: "main", list: [{ id: "main" }] },
  bindings: [],
} as OpenClawConfig;

type ParsedWsFrame = Record<string, unknown>;

const decodeRawData = (data: WebSocket.RawData): string => {
  if (typeof data === "string") {
    return data;
  }

  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  return Buffer.from(data).toString("utf8");
};

async function ensureTmuxAvailable(): Promise<boolean> {
  const { execFile: execFileCb } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFile = promisify(execFileCb);
  try {
    const { stdout } = await execFile("which", ["tmux"]);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function setupFakeSshProxy(): Promise<{
  logPath: string;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawline-fake-ssh-"));
  const logPath = path.join(root, "ssh.log");
  const scriptPath = path.join(root, "ssh");
  await fs.writeFile(
    scriptPath,
    `#!/bin/sh
set -eu
if [ "$#" -lt 2 ]; then
  exit 64
fi
while [ "$#" -gt 2 ]; do
  shift
done
target="$1"
remote_cmd="$2"
printf '%s\\n' "$target" >> "$FAKE_SSH_LOG_FILE"
if [ "\${FAKE_SSH_FAIL_TARGET:-}" = "$target" ]; then
  exit 255
fi
exec /bin/sh -lc "$remote_cmd"
`,
    { mode: 0o755 },
  );

  const originalPath = process.env.PATH ?? "";
  process.env.PATH = `${root}${path.delimiter}${originalPath}`;
  process.env.FAKE_SSH_LOG_FILE = logPath;

  return {
    logPath,
    cleanup: async () => {
      process.env.PATH = originalPath;
      delete process.env.FAKE_SSH_LOG_FILE;
      delete process.env.FAKE_SSH_FAIL_TARGET;
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

async function createTerminalAuthToken(
  allowlistPath: string,
  entry: AllowlistEntry,
): Promise<string> {
  const statePath = path.dirname(allowlistPath);
  const jwtKey = (await fs.readFile(path.join(statePath, "jwt.key"), "utf8")).trim();
  return jwt.sign({ sub: entry.userId, deviceId: entry.deviceId, isAdmin: entry.isAdmin }, jwtKey, {
    algorithm: "HS256",
  });
}

async function authenticateTerminalSession(params: {
  port: number;
  allowlistPath: string;
  entry: AllowlistEntry;
  terminalSessionId: string;
  authPayloadExtras?: Record<string, unknown>;
}): Promise<{ ws: WebSocket; response: ParsedWsFrame }> {
  const authToken = await createTerminalAuthToken(params.allowlistPath, params.entry);
  const ws = new WebSocket(`ws://127.0.0.1:${params.port}/ws/terminal`);
  await waitForOpen(ws);

  const messagePromise = new Promise<ParsedWsFrame>((resolve) => {
    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        return;
      }
      try {
        const parsed = JSON.parse(decodeRawData(raw));
        if (parsed && typeof parsed === "object" && "type" in parsed) {
          resolve(parsed);
        }
      } catch {
        // Ignore non-JSON text frames.
      }
    });
  });

  ws.send(
    JSON.stringify({
      type: "terminal_auth",
      protocolVersion: PROTOCOL_VERSION,
      terminalSessionId: params.terminalSessionId,
      deviceId: params.entry.deviceId,
      authToken,
      cols: 80,
      rows: 24,
      backfillLines: 0,
      ...params.authPayloadExtras,
    }),
  );

  const response = await Promise.race([
    messagePromise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Timed out waiting for terminal auth response")), 10_000),
    ),
  ]);

  return { ws, response };
}

async function readFakeSshTargets(logPath: string): Promise<string[]> {
  const contents = await fs.readFile(logPath, "utf8").catch(() => "");
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function killLocalTmuxSession(sessionName: string): Promise<void> {
  const { execFile: execFileCb } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFile = promisify(execFileCb);
  try {
    await execFile("tmux", ["kill-session", "-t", sessionName]);
  } catch {
    // Best effort cleanup.
  }
}

function decodeTerminalDescriptorFromResult(result: ClawlineOutboundSendResult) {
  const attachment = result.attachments?.find(
    (item) =>
      item.type === "document" &&
      item.mimeType === "application/vnd.clawline.terminal-session+json",
  );
  if (!attachment || attachment.type !== "document") {
    throw new Error("Expected terminal-session document attachment in outbound result");
  }
  return JSON.parse(Buffer.from(attachment.data, "base64").toString("utf8")) as {
    version: number;
    terminalSessionId: string;
    title?: string;
    destination?: { address?: string };
  };
}

function createMessageQueue(ws: WebSocket) {
  const queued: ParsedWsFrame[] = [];
  const waiters: Array<(value: ParsedWsFrame) => void> = [];

  const onMessage = (data: WebSocket.RawData) => {
    let parsed: ParsedWsFrame;
    try {
      parsed = JSON.parse(decodeRawData(data)) as ParsedWsFrame;
    } catch {
      parsed = { rawText: decodeRawData(data) };
    }
    const waiter = waiters.shift();
    if (waiter) {
      waiter(parsed);
      return;
    }
    queued.push(parsed);
  };

  ws.on("message", onMessage);

  return {
    next: () =>
      queued.length > 0
        ? Promise.resolve(queued.shift() as ParsedWsFrame)
        : new Promise<ParsedWsFrame>((resolve) => waiters.push(resolve)),
    dispose: () => ws.off("message", onMessage),
  };
}

beforeEach(() => {
  gatewayCallMock.mockReset();
  gatewayCallMock.mockResolvedValue({ ok: true });
  enqueueAnnounceMock.mockReset();
  enqueueAnnounceMock.mockReturnValue(true);
  abortAgentHarnessRunMock.mockReset();
  abortAgentHarnessRunMock.mockReturnValue(false);
  resolveActiveAgentHarnessRunSessionIdMock.mockReset();
  resolveActiveAgentHarnessRunSessionIdMock.mockReturnValue(undefined);
  loadModelCatalogMock.mockReset();
  loadModelCatalogMock.mockResolvedValue([
    {
      id: "gpt-5",
      name: "GPT-5",
      provider: "openai",
      contextWindow: 400000,
      reasoning: true,
      input: ["text"],
    },
    {
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      provider: "anthropic",
      contextWindow: 200000,
      reasoning: true,
      input: ["text", "image"],
    },
  ]);
  loadSessionStoreMock.mockClear();
  sendMessageMock.mockReset();
  sendMessageMock.mockResolvedValue({
    channel: "clawline",
    to: "flynn",
    via: "direct",
    mediaUrl: null,
  });
  resetSystemEventsForTest();
});

afterAll(async () => {
  // Undici keeps connections alive by default; close the global dispatcher so Vitest can exit.
  const dispatcher = getGlobalDispatcher() as unknown as { close?: () => unknown };
  if (typeof dispatcher.close === "function") {
    await dispatcher.close();
  }
});

type TestServerContext = {
  server: ProviderServer;
  port: number;
  allowlistPath: string;
  pendingPath: string;
  mediaPath: string;
  sessionStorePath: string;
  alertInstructionsPath: string;
  webRootPath: string;
  cleanup: () => Promise<void>;
};

const createAllowlistEntry = (overrides: Partial<AllowlistEntry> = {}): AllowlistEntry => ({
  deviceId: "cb76ad36-1e3b-4ff0-8249-ad8e4104bfa1",
  claimedName: "flynn",
  deviceInfo: {
    platform: "iOS",
    model: "iPhone",
    osVersion: "17.0",
    appVersion: "1.0",
  },
  userId: "flynn",
  isAdmin: true,
  tokenDelivered: true,
  createdAt: Date.now(),
  lastSeenAt: Date.now(),
  ...overrides,
});

const createAuthHeader = async (ctx: TestServerContext, entry: AllowlistEntry): Promise<string> => {
  const statePath = path.dirname(ctx.allowlistPath);
  const jwtKey = (await fs.readFile(path.join(statePath, "jwt.key"), "utf8")).trim();
  const payload: jwt.JwtPayload = {
    sub: entry.userId,
    deviceId: entry.deviceId,
    isAdmin: entry.isAdmin,
    iat: Math.floor(Date.now() / 1000),
  };
  const token = jwt.sign(payload, jwtKey, { algorithm: "HS256", issuer: "clawline" });
  return `Bearer ${token}`;
};

const createAuthToken = async (ctx: TestServerContext, entry: AllowlistEntry): Promise<string> => {
  const authHeader = await createAuthHeader(ctx, entry);
  return authHeader.replace(/^Bearer\s+/i, "");
};

async function setupTestServer(
  initialAllowlist: AllowlistEntry[] = [],
  options: {
    alertInstructionsText?: string | null;
    network?: Partial<ProviderConfig["network"]>;
    sessionStorePathRelative?: string;
    webRootFollowSymlinks?: boolean;
    webRootPathRelative?: string;
    seedLegacyDatabase?: (dbPath: string) => Promise<void>;
    replyResolver?: typeof getReplyFromConfig;
    logger?: Logger;
    openClawConfig?: OpenClawConfig;
    terminalTmux?: {
      mode?: "local" | "ssh";
      sshTarget?: string;
    };
  } = {},
): Promise<TestServerContext> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawline-server-test-"));
  const statePath = path.join(root, "state");
  const mediaPath = path.join(root, "media");
  await fs.mkdir(statePath, { recursive: true });
  await fs.mkdir(mediaPath, { recursive: true });
  const webRootPathRelative = options.webRootPathRelative ?? "www";
  if (path.isAbsolute(webRootPathRelative)) {
    throw new Error("setupTestServer: webRootPathRelative must be relative");
  }
  const webRootPath = path.join(root, webRootPathRelative);
  await fs.mkdir(webRootPath, { recursive: true });
  await fs.mkdir(path.join(webRootPath, "media"), { recursive: true });
  await fs.writeFile(path.join(webRootPath, "index.html"), "<html><body>root index</body></html>");
  await fs.mkdir(path.join(mediaPath, "assets"), { recursive: true });
  await fs.mkdir(path.join(mediaPath, "tmp"), { recursive: true });
  const sessionStorePathRelative =
    options.sessionStorePathRelative ?? path.join("sessions", "sessions.json");
  const sessionStorePath = path.join(root, sessionStorePathRelative);
  await fs.mkdir(path.dirname(sessionStorePath), { recursive: true });
  const allowlistPath = path.join(statePath, "allowlist.json");
  await fs.writeFile(
    allowlistPath,
    JSON.stringify({ version: 1, entries: initialAllowlist }, null, 2),
  );
  const pendingPath = path.join(statePath, "pending.json");
  await fs.writeFile(pendingPath, JSON.stringify({ version: 1, entries: [] }, null, 2));
  await fs.writeFile(path.join(statePath, "denylist.json"), "[]");
  const dbPath = path.join(statePath, "clawline.sqlite");
  if (typeof options.seedLegacyDatabase === "function") {
    await options.seedLegacyDatabase(dbPath);
  }
  const alertInstructionsPath = path.join(root, "alert-instructions.md");
  if (options.alertInstructionsText !== null) {
    const contents = options.alertInstructionsText ?? "";
    await fs.writeFile(alertInstructionsPath, contents);
  }

  const server = await createProviderServer({
    config: {
      port: 0,
      statePath,
      media: {
        storagePath: mediaPath,
        maxInlineBytes: 256_000,
        maxUploadBytes: 8_000_000,
        unreferencedUploadTtlSeconds: 86_400,
      },
      ...(options.network
        ? {
            network: {
              bindAddress: options.network.bindAddress ?? "127.0.0.1",
              allowInsecurePublic: options.network.allowInsecurePublic ?? false,
              ...(options.network.allowedOrigins
                ? { allowedOrigins: options.network.allowedOrigins }
                : {}),
            } satisfies ProviderConfig["network"],
          }
        : {}),
      alertInstructionsPath,
      webRootPath,
      webRoot: { followSymlinks: options.webRootFollowSymlinks === true },
      ...(options.terminalTmux
        ? {
            terminal: {
              tmux: {
                mode: options.terminalTmux.mode ?? "local",
                ssh: {
                  target: options.terminalTmux.sshTarget ?? "",
                },
              },
            },
          }
        : {}),
    },
    openClawConfig: options.openClawConfig ?? testOpenClawConfig,
    replyResolver: options.replyResolver ?? testReplyResolver,
    logger: options.logger ?? silentLogger,
    sessionStorePath,
  });
  await server.start();
  const cleanup = async () => {
    await server.stop();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await fs.rm(root, { recursive: true, force: true });
        return;
      } catch (err) {
        const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
        if (code !== "ENOTEMPTY" && code !== "EBUSY") {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
    await fs.rm(root, { recursive: true, force: true });
  };
  return {
    server,
    port: server.getPort(),
    allowlistPath,
    pendingPath,
    mediaPath,
    sessionStorePath,
    alertInstructionsPath,
    webRootPath,
    cleanup,
  };
}

type PairRequestOverrides = {
  claimedName?: string;
};

function createPairRequestPayload(deviceId: string, overrides: PairRequestOverrides = {}) {
  return {
    type: "pair_request",
    protocolVersion: PROTOCOL_VERSION,
    deviceId,
    deviceInfo: {
      platform: "iOS",
      model: "iPhone",
      osVersion: "17.0",
      appVersion: "1.0",
    },
    ...(overrides.claimedName ? { claimedName: overrides.claimedName } : {}),
  };
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("WebSocket open timeout"));
    }, 2000);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("open", handleOpen);
      ws.off("error", handleError);
    };
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleError = (err: Error) => {
      cleanup();
      reject(err);
    };
    ws.once("open", handleOpen);
    ws.once("error", handleError);
  });
}

function waitForMessage(ws: WebSocket): Promise<ParsedWsFrame> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const cleanup = () => {
      ws.off("message", handleMessage);
      ws.off("error", handleError);
      ws.off("close", handleClose);
    };
    const handleMessage = (data: WebSocket.RawData) => {
      if (resolved) {
        return;
      }
      resolved = true;
      cleanup();
      try {
        resolve(JSON.parse(decodeRawData(data)) as ParsedWsFrame);
      } catch (err) {
        reject(err);
      }
    };
    const handleError = (err: Error) => {
      if (resolved) {
        return;
      }
      resolved = true;
      cleanup();
      reject(err);
    };
    const handleClose = () => {
      if (resolved) {
        return;
      }
      resolved = true;
      cleanup();
      reject(new Error("WebSocket closed before message"));
    };
    ws.once("message", handleMessage);
    ws.once("error", handleError);
    ws.once("close", handleClose);
  });
}

async function waitForQueuedMessage(
  queue: ReturnType<typeof createMessageQueue>,
  predicate: (value: unknown) => boolean,
  attempts = 12,
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await queue.next();
    if (predicate(value)) {
      return value;
    }
  }
  throw new Error(`Did not receive expected queued message within ${attempts} attempts`);
}

async function waitForQueuedMessageWithTimeout(
  queue: ReturnType<typeof createMessageQueue>,
  predicate: (value: unknown) => boolean,
  options: { attempts?: number; timeoutMs?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? 3_000;
  return Promise.race([
    waitForQueuedMessage(queue, predicate, options.attempts),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timed out waiting for queued message after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    ),
  ]);
}

async function collectQueuedMessagesUntilIdle(
  queue: ReturnType<typeof createMessageQueue>,
  options: { idleMs?: number; maxMessages?: number } = {},
) {
  const idleMs = options.idleMs ?? 150;
  const maxMessages = options.maxMessages ?? 100;
  const messages: ParsedWsFrame[] = [];
  for (let index = 0; index < maxMessages; index += 1) {
    const next = await Promise.race([
      queue.next(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), idleMs)),
    ]);
    if (next === null) {
      break;
    }
    messages.push(next);
  }
  return messages;
}

async function performPairRequest(
  port: number,
  deviceId: string,
  overrides: PairRequestOverrides = {},
) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await waitForOpen(ws);
  // Avoid a race where the server replies before we attach a message listener.
  const responsePromise = waitForMessage(ws);
  ws.send(JSON.stringify(createPairRequestPayload(deviceId, overrides)));
  try {
    return await responsePromise;
  } finally {
    ws.terminate();
  }
}

async function performPairRequestWithOrigin(
  port: number,
  deviceId: string,
  origin: string,
  overrides: PairRequestOverrides = {},
) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: origin } });
  await waitForOpen(ws);
  const responsePromise = waitForMessage(ws);
  ws.send(JSON.stringify(createPairRequestPayload(deviceId, overrides)));
  try {
    return await responsePromise;
  } finally {
    ws.terminate();
  }
}

async function performRawWebSocketUpgrade(port: number, origin: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];

    socket.on("connect", () => {
      socket.write(
        [
          "GET /ws HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGVzdC1zZWVkLWtleQ==",
          `Origin: ${origin}`,
          "",
          "",
        ].join("\r\n"),
      );
    });

    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on("error", reject);
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function uploadAsset(port: number, token: string, data: Buffer, mimeType: string) {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(data)], { type: mimeType }), "upload.bin");
  const response = await fetch(`http://127.0.0.1:${port}/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`Upload failed with status ${response.status}`);
  }
  return response.json() as Promise<{ assetId: string; mimeType: string; size: number }>;
}

async function authenticateDevice(
  port: number,
  deviceId: string,
  token: string,
  options: { authPayload?: Record<string, unknown> } = {},
) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await waitForOpen(ws);
  // Buffer messages to avoid races (auth_result, stream_snapshot, and session_info can arrive fast).
  const queue = createMessageQueue(ws);
  ws.send(
    JSON.stringify({
      type: "auth",
      protocolVersion: PROTOCOL_VERSION,
      deviceId,
      token,
      ...options.authPayload,
    }),
  );
  const auth = await queue.next();
  if (!auth?.success) {
    queue.dispose();
    ws.terminate();
    throw new Error(
      `Auth failed for ${deviceId}: ${typeof auth === "object" ? JSON.stringify(auth) : auth}`,
    );
  }
  const streamSnapshot = await queue.next();
  if (streamSnapshot?.type !== "stream_snapshot") {
    queue.dispose();
    ws.terminate();
    throw new Error(
      `Expected stream_snapshot after auth_result, got ${JSON.stringify(streamSnapshot)}`,
    );
  }
  let sessionInfo: unknown = null;
  if (Array.isArray(auth.features) && auth.features.includes("session_info")) {
    const next = await queue.next();
    if (next?.type !== "session_info") {
      queue.dispose();
      ws.terminate();
      throw new Error(`Expected session_info after stream_snapshot, got ${JSON.stringify(next)}`);
    }
    sessionInfo = next;
  }
  if (auth.replayCount === 0) {
    const syncComplete = await queue.next();
    if (syncComplete?.type !== "sync_complete") {
      queue.dispose();
      ws.terminate();
      throw new Error(
        `Expected sync_complete after auth setup, got ${JSON.stringify(syncComplete)}`,
      );
    }
  }
  queue.dispose();
  return { ws, auth, streamSnapshot, sessionInfo };
}

async function authenticateDeviceWithQueue(
  port: number,
  deviceId: string,
  token: string,
  options: { authPayload?: Record<string, unknown> } = {},
) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await waitForOpen(ws);
  const queue = createMessageQueue(ws);
  ws.send(
    JSON.stringify({
      type: "auth",
      protocolVersion: PROTOCOL_VERSION,
      deviceId,
      token,
      ...options.authPayload,
    }),
  );
  const auth = await queue.next();
  if (!auth?.success) {
    queue.dispose();
    ws.terminate();
    throw new Error(
      `Auth failed for ${deviceId}: ${typeof auth === "object" ? JSON.stringify(auth) : auth}`,
    );
  }
  const streamSnapshot = await queue.next();
  if (streamSnapshot?.type !== "stream_snapshot") {
    queue.dispose();
    ws.terminate();
    throw new Error(
      `Expected stream_snapshot after auth_result, got ${JSON.stringify(streamSnapshot)}`,
    );
  }
  let sessionInfo: unknown = null;
  if (Array.isArray(auth.features) && auth.features.includes("session_info")) {
    const next = await queue.next();
    if (next?.type !== "session_info") {
      queue.dispose();
      ws.terminate();
      throw new Error(`Expected session_info after stream_snapshot, got ${JSON.stringify(next)}`);
    }
    sessionInfo = next;
  }
  return { ws, queue, auth, streamSnapshot, sessionInfo };
}

describe.sequential("clawline provider server", () => {
  it("accepts local, private, and tailnet browser origins without explicit allowlist entries", async () => {
    const ctx = await setupTestServer([], {
      network: {
        bindAddress: "0.0.0.0",
        allowInsecurePublic: true,
        allowedOrigins: [],
      },
    });
    try {
      const origins = [
        "http://127.0.0.1:4173",
        "http://10.0.0.24:4173",
        "https://flynn-workbench.ts.net",
      ];

      for (const origin of origins) {
        const response = await performPairRequestWithOrigin(ctx.port, randomUUID(), origin);
        expect(response).toMatchObject({
          type: "pair_result",
          success: false,
          reason: "pair_pending",
        });
      }
    } finally {
      await ctx.cleanup();
    }
  });

  it("answers stream api browser preflights and requests for local, private, and tailnet origins", async () => {
    const entry = createAllowlistEntry();
    const ctx = await setupTestServer([entry], {
      network: {
        bindAddress: "0.0.0.0",
        allowInsecurePublic: true,
        allowedOrigins: [],
      },
    });
    try {
      const pairResult = await performPairRequest(ctx.port, entry.deviceId, {
        claimedName: entry.claimedName,
      });
      const authToken = pairResult.token as string;
      const { ws } = await authenticateDevice(ctx.port, entry.deviceId, authToken);
      const authHeader = `Bearer ${authToken}`;
      const origins = [
        "http://127.0.0.1:4173",
        "http://10.0.0.24:4173",
        "https://flynn-workbench.ts.net",
      ];

      for (const origin of origins) {
        const preflight = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
          method: "OPTIONS",
          headers: {
            Origin: origin,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
          },
        });
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
        expect(preflight.headers.get("access-control-allow-methods")).toContain("GET");
        expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");

        const response = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
          headers: {
            Authorization: authHeader,
            Origin: origin,
          },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      }
      ws.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("rejects public stream api browser origins unless they are explicitly allowlisted", async () => {
    const entry = createAllowlistEntry();
    const blockedOrigin = "https://example.com";
    const allowedOrigin = "https://clawline.app";
    const ctx = await setupTestServer([entry], {
      network: {
        bindAddress: "0.0.0.0",
        allowInsecurePublic: true,
        allowedOrigins: [allowedOrigin],
      },
    });
    try {
      const pairResult = await performPairRequest(ctx.port, entry.deviceId, {
        claimedName: entry.claimedName,
      });
      const authToken = pairResult.token as string;
      const { ws } = await authenticateDevice(ctx.port, entry.deviceId, authToken);
      const authHeader = `Bearer ${authToken}`;

      const blockedResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        headers: {
          Authorization: authHeader,
          Origin: blockedOrigin,
        },
      });
      expect(blockedResponse.status).toBe(403);
      expect(await blockedResponse.json()).toMatchObject({
        error: {
          code: "origin_not_allowed",
        },
      });

      const allowedResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        headers: {
          Authorization: authHeader,
          Origin: allowedOrigin,
        },
      });
      expect(allowedResponse.status).toBe(200);
      expect(allowedResponse.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
      ws.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("exposes session status and typed control capabilities", async () => {
    const entry = createAllowlistEntry();
    const sessionKey = "agent:main:clawline:flynn:main";
    const adoptedSessionKey = "agent:heimdal:main";
    const ctx = await setupTestServer([entry], {
      openClawConfig: {
        agents: {
          default: "main",
          defaults: {
            model: { primary: "openai/gpt-5" },
            models: {
              "openai/gpt-5": {},
              "anthropic/claude-sonnet-4-6": {},
            },
          },
          list: [{ id: "main" }],
        },
        bindings: [],
      } as OpenClawConfig,
    });
    try {
      await fs.writeFile(
        ctx.sessionStorePath,
        JSON.stringify(
          {
            [sessionKey]: {
              sessionId: "session-status-test",
              updatedAt: Date.now(),
              modelProvider: "anthropic",
              model: "claude-opus-4-6",
              thinkingLevel: "high",
              fastMode: false,
              verboseLevel: "off",
              reasoningLevel: "on",
            },
            [adoptedSessionKey]: {
              sessionId: "adopted-session-status-test",
              updatedAt: Date.now(),
              modelProvider: "openai",
              model: "gpt-5",
            },
          },
          null,
          2,
        ),
      );
      const pairResult = await performPairRequest(ctx.port, entry.deviceId, {
        claimedName: entry.claimedName,
      });
      const authToken = pairResult.token as string;
      const { ws } = await authenticateDevice(ctx.port, entry.deviceId, authToken);
      const authHeader = `Bearer ${authToken}`;

      const statusResponse = await fetch(
        `http://127.0.0.1:${ctx.port}/api/session-status?sessionKey=${encodeURIComponent(
          sessionKey,
        )}`,
        { headers: { Authorization: authHeader } },
      );
      expect(statusResponse.status).toBe(200);
      const statusJson = await statusResponse.json();
      expect(statusJson).toMatchObject({
        sessionKey,
        display: {
          model: "claude-opus-4-6",
          provider: "anthropic",
          thinkingLevel: "high",
          fastMode: false,
          mode: "normal",
          verbosity: "off",
          reasoningLevel: "on",
        },
        run: {
          state: "idle",
          queueDepth: 0,
        },
        capabilities: {
          cancelCurrentRun: { supported: true },
          setModel: { supported: true },
          setThinking: { supported: true },
          setReasoning: { supported: true },
          setFastMode: { supported: true },
          setMode: { supported: true },
          setVerbosity: { supported: true },
        },
        modelCatalog: {
          available: true,
          models: expect.arrayContaining([
            expect.objectContaining({
              id: "gpt-5",
              provider: "openai",
              ref: "openai/gpt-5",
              name: "GPT-5",
            }),
            expect.objectContaining({
              id: "claude-sonnet-4-6",
              provider: "anthropic",
              ref: "anthropic/claude-sonnet-4-6",
              name: "Claude Sonnet 4.6",
            }),
          ]),
        },
      });
      const catalogModels = (statusJson as { modelCatalog?: { models?: Array<{ ref?: string }> } })
        .modelCatalog?.models;
      const sonnetModelRef = catalogModels?.find(
        (model) => model.ref === "anthropic/claude-sonnet-4-6",
      )?.ref;
      expect(sonnetModelRef).toBe("anthropic/claude-sonnet-4-6");

      const controlResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/session-control`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionKey, action: "cancel_current_run" }),
      });
      expect(controlResponse.status).toBe(200);
      expect(await controlResponse.json()).toMatchObject({
        ok: false,
        sessionKey,
        action: "cancel_current_run",
        code: "no_active_run",
        capabilities: {
          cancelCurrentRun: { supported: true },
        },
      });
      expect(abortAgentHarnessRunMock).not.toHaveBeenCalled();

      const adoptResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams/adopt`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionKey: adoptedSessionKey }),
      });
      expect(adoptResponse.status).toBe(200);

      const adoptedModelResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/session-control`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionKey: adoptedSessionKey,
          action: "set_model",
          model: "openai/gpt-5",
        }),
      });
      expect(adoptedModelResponse.status).toBe(200);
      expect(await adoptedModelResponse.json()).toMatchObject({
        ok: false,
        sessionKey: adoptedSessionKey,
        action: "set_model",
        code: "unsupported",
        capabilities: {
          readOnlyStatus: true,
          setModel: { supported: false, reason: "adopted_session_read_only" },
        },
      });

      const thinkingResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/session-control`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionKey, action: "set_thinking", thinkingLevel: "low" }),
      });
      expect(thinkingResponse.status).toBe(200);
      expect(await thinkingResponse.json()).toMatchObject({
        ok: true,
        sessionKey,
        action: "set_thinking",
        status: {
          display: {
            thinkingLevel: "low",
          },
        },
      });

      const fastResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/session-control`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionKey, action: "set_fast_mode", fastMode: true }),
      });
      expect(fastResponse.status).toBe(200);
      expect(await fastResponse.json()).toMatchObject({
        ok: true,
        status: {
          display: {
            fastMode: true,
            mode: "fast",
          },
        },
      });

      const nullModelResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/session-control`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionKey, action: "set_model", model: null }),
      });
      expect(nullModelResponse.status).toBe(400);
      expect(await nullModelResponse.json()).toMatchObject({
        error: {
          code: "invalid_control_payload",
        },
      });

      const badModelResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/session-control`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionKey, action: "set_model", model: "anthropic/not-real" }),
      });
      expect(badModelResponse.status).toBe(200);
      expect(await badModelResponse.json()).toMatchObject({
        ok: false,
        sessionKey,
        action: "set_model",
        code: "INVALID_REQUEST",
      });

      const modelResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/session-control`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionKey,
          action: "set_model",
          model: sonnetModelRef,
        }),
      });
      expect(modelResponse.status).toBe(200);
      expect(await modelResponse.json()).toMatchObject({
        ok: true,
        sessionKey,
        action: "set_model",
        status: {
          display: {
            model: "claude-sonnet-4-6",
            provider: "anthropic",
          },
        },
        capabilities: {
          setModel: { supported: true },
        },
      });

      const updatedStatusResponse = await fetch(
        `http://127.0.0.1:${ctx.port}/api/session-status?sessionKey=${encodeURIComponent(
          sessionKey,
        )}`,
        { headers: { Authorization: authHeader } },
      );
      expect(updatedStatusResponse.status).toBe(200);
      expect(await updatedStatusResponse.json()).toMatchObject({
        display: {
          model: "claude-sonnet-4-6",
          provider: "anthropic",
          thinkingLevel: "low",
          fastMode: true,
          mode: "fast",
        },
      });

      ws.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("cancels an in-flight session run through the provider abort seam", async () => {
    const entry = createAllowlistEntry();
    const sessionKey = "agent:main:clawline:flynn:main";
    let releaseReply: (() => void) | undefined;
    const replyResolver: typeof testReplyResolver = async () => {
      await new Promise<void>((resolve) => {
        releaseReply = resolve;
      });
      return { text: "" };
    };
    const ctx = await setupTestServer([entry], { replyResolver });
    try {
      await fs.writeFile(
        ctx.sessionStorePath,
        JSON.stringify(
          {
            [sessionKey]: {
              sessionId: "session-cancel-test",
              updatedAt: Date.now(),
              channel: "clawline",
              lastChannel: "clawline",
              lastTo: "device:test",
            },
          },
          null,
          2,
        ),
      );
      abortAgentHarnessRunMock.mockReturnValue(true);
      resolveActiveAgentHarnessRunSessionIdMock.mockReturnValue("session-cancel-live");
      const pairResult = await performPairRequest(ctx.port, entry.deviceId, {
        claimedName: entry.claimedName,
      });
      const authToken = pairResult.token as string;
      const { ws, queue } = await authenticateDeviceWithQueue(ctx.port, entry.deviceId, authToken);
      const messageId = `c_${randomUUID()}`;
      try {
        ws.send(
          JSON.stringify({
            type: "message",
            id: messageId,
            sessionKey,
            content: "cancel me",
          }),
        );
        await waitForQueuedMessage(queue, (value) => {
          const typed = value as { type?: string; id?: string };
          return typed?.type === "ack" && typed.id === messageId;
        });

        let runningStatus: Record<string, unknown> | undefined;
        for (let attempt = 0; attempt < 400; attempt += 1) {
          const response = await fetch(
            `http://127.0.0.1:${ctx.port}/api/session-status?sessionKey=${encodeURIComponent(
              sessionKey,
            )}`,
            { headers: { Authorization: `Bearer ${authToken}` } },
          );
          const status = (await response.json()) as Record<string, unknown>;
          if ((status.run as { state?: string } | undefined)?.state === "running") {
            runningStatus = status;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(runningStatus).toMatchObject({
          capabilities: {
            cancelCurrentRun: { supported: true },
          },
          run: {
            state: "running",
            messageId,
          },
        });

        const controlResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/session-control`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ sessionKey, action: "cancel_current_run" }),
        });
        expect(controlResponse.status).toBe(200);
        expect(await controlResponse.json()).toMatchObject({
          ok: true,
          sessionKey,
          action: "cancel_current_run",
        });
        expect(resolveActiveAgentHarnessRunSessionIdMock).toHaveBeenCalledWith(sessionKey);
        expect(abortAgentHarnessRunMock).toHaveBeenCalledWith("session-cancel-live");

        releaseReply?.();
        releaseReply = undefined;
        let idleStatus: Record<string, unknown> | undefined;
        for (let attempt = 0; attempt < 400; attempt += 1) {
          const response = await fetch(
            `http://127.0.0.1:${ctx.port}/api/session-status?sessionKey=${encodeURIComponent(
              sessionKey,
            )}`,
            { headers: { Authorization: `Bearer ${authToken}` } },
          );
          const status = (await response.json()) as Record<string, unknown>;
          if ((status.run as { state?: string } | undefined)?.state === "idle") {
            idleStatus = status;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(idleStatus).toMatchObject({
          run: {
            state: "idle",
          },
        });
        await expect(
          waitForQueuedMessageWithTimeout(
            queue,
            (value) => {
              const typed = value as { type?: string; code?: string; messageId?: string };
              return (
                typed?.type === "error" &&
                typed.code === "server_error" &&
                typed.messageId === messageId
              );
            },
            { attempts: 2, timeoutMs: 50 },
          ),
        ).rejects.toThrow(/Timed out|Did not receive/);
      } finally {
        releaseReply?.();
        queue.dispose();
        ws.terminate();
      }
    } finally {
      await ctx.cleanup();
    }
  });

  it("includes exact device ids in pending approval alerts", async () => {
    const ctx = await setupTestServer([], {
      alertInstructionsText: "",
    });
    const deviceId = randomUUID();
    try {
      const response = await performPairRequest(ctx.port, deviceId, { claimedName: "flynn" });
      expect(response).toMatchObject({
        type: "pair_result",
        success: false,
        reason: "pair_pending",
      });
      const call = enqueueAnnounceMock.mock.calls[0]?.[0] as
        | { item?: { prompt?: string } }
        | undefined;
      expect(call?.item?.prompt).toContain(
        `New device pending approval: flynn (iOS/iPhone) [deviceId: ${deviceId}]`,
      );
    } finally {
      await ctx.cleanup();
    }
  });

  it("logs exact device ids when pending approvals are delivered", async () => {
    const infoEntries: string[] = [];
    const ctx = await setupTestServer([], {
      logger: {
        ...silentLogger,
        info: (message: string) => infoEntries.push(message),
      },
    });
    const deviceId = randomUUID();
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws`);
    await waitForOpen(ws);
    const queue = createMessageQueue(ws);
    try {
      ws.send(JSON.stringify(createPairRequestPayload(deviceId, { claimedName: "flynn" })));
      const pendingResult = await waitForQueuedMessage(
        queue,
        (value) =>
          typeof value === "object" &&
          value !== null &&
          "type" in value &&
          (value as { type?: string }).type === "pair_result",
      );
      expect(pendingResult).toMatchObject({
        type: "pair_result",
        success: false,
        reason: "pair_pending",
      });

      const allowlist = JSON.parse(await fs.readFile(ctx.allowlistPath, "utf8")) as {
        version: number;
        entries: AllowlistEntry[];
      };
      allowlist.entries.push(
        createAllowlistEntry({
          deviceId,
          claimedName: "flynn",
          tokenDelivered: false,
          lastSeenAt: null,
        }),
      );
      await fs.writeFile(ctx.allowlistPath, `${JSON.stringify(allowlist, null, 2)}\n`);

      const approvedResult = await waitForQueuedMessage(
        queue,
        (value) =>
          typeof value === "object" &&
          value !== null &&
          "type" in value &&
          (value as { type?: string; success?: boolean }).type === "pair_result" &&
          (value as { success?: boolean }).success === true,
      );
      expect(approvedResult).toMatchObject({
        type: "pair_result",
        success: true,
        userId: "flynn",
      });
      await vi.waitFor(() => {
        expect(infoEntries).toContain(
          `[clawline:http] pending_approval_delivered flynn (iOS/iPhone) [deviceId: ${deviceId}] userId=flynn isAdmin=true delivered=true`,
        );
      });
      expect(infoEntries).toContain(
        `[clawline:http] pair_request_upsert_pending flynn (iOS/iPhone) [deviceId: ${deviceId}] pendingCount=1`,
      );
    } finally {
      queue.dispose();
      ws.terminate();
      await ctx.cleanup();
    }
  });

  it("rejects unlisted public browser origins with a config hint", async () => {
    const warnEntries: unknown[][] = [];
    const logger: Logger = {
      info: () => {},
      warn: (...args: unknown[]) => warnEntries.push(args),
      error: () => {},
    };
    const ctx = await setupTestServer([], {
      logger,
      network: {
        bindAddress: "0.0.0.0",
        allowInsecurePublic: true,
        allowedOrigins: [],
      },
    });
    try {
      const response = await performRawWebSocketUpgrade(ctx.port, "https://example.com");
      expect(response).toContain("HTTP/1.1 403 Forbidden");
      expect(response).toContain("channels.clawline.network.allowedOrigins");
      expect(response).toContain("https://example.com");
      expect(warnEntries).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([
            "[clawline:http] ws_upgrade_origin_rejected",
            expect.objectContaining({
              origin: "https://example.com",
              setting: "channels.clawline.network.allowedOrigins",
            }),
          ]),
        ]),
      );
    } finally {
      await ctx.cleanup();
    }
  });

  it("accepts explicitly allowlisted public browser origins", async () => {
    const ctx = await setupTestServer([], {
      network: {
        bindAddress: "0.0.0.0",
        allowInsecurePublic: true,
        allowedOrigins: ["https://clawline.app"],
      },
    });
    try {
      const response = await performPairRequestWithOrigin(
        ctx.port,
        randomUUID(),
        "https://clawline.app",
      );
      expect(response).toMatchObject({
        type: "pair_result",
        success: false,
        reason: "pair_pending",
      });
    } finally {
      await ctx.cleanup();
    }
  });

  it("reissues tokens for already approved devices", async () => {
    const deviceId = randomUUID();
    const originalLastSeen = Date.now() - 10_000;
    const entry: AllowlistEntry = {
      deviceId,
      claimedName: "Flynn",
      deviceInfo: {
        platform: "iOS",
        model: "iPhone",
        osVersion: "17.0",
        appVersion: "1.0",
      },
      userId: "flynn",
      isAdmin: true,
      tokenDelivered: true,
      createdAt: Date.now() - 60_000,
      lastSeenAt: originalLastSeen,
    };
    const ctx = await setupTestServer([entry]);
    try {
      const response = await performPairRequest(ctx.port, deviceId);
      expect(response).toMatchObject({
        type: "pair_result",
        success: true,
        userId: entry.userId,
      });
      expect(typeof response.token).toBe("string");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const allowlist = JSON.parse(await fs.readFile(ctx.allowlistPath, "utf8")) as {
        entries: AllowlistEntry[];
      };
      const updated = allowlist.entries.find((item) => item.deviceId === deviceId);
      expect(updated).toBeTruthy();
      expect(updated?.lastSeenAt).not.toBeNull();
      expect((updated?.lastSeenAt ?? 0) > originalLastSeen).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  });

  it("retains pending pairing entry after websocket disconnect", async () => {
    const deviceId = randomUUID();
    const ctx = await setupTestServer();
    try {
      const response = await performPairRequest(ctx.port, deviceId);
      expect(response).toMatchObject({
        type: "pair_result",
        success: false,
        reason: "pair_pending",
      });
      const contents = await fs.readFile(ctx.pendingPath, "utf8");
      const pending = JSON.parse(contents);
      expect(pending.entries).toEqual(
        expect.arrayContaining([expect.objectContaining({ deviceId })]),
      );
    } finally {
      await ctx.cleanup();
    }
  });

  it("queues a session alert when a pairing request becomes pending", async () => {
    const deviceId = randomUUID();
    const ctx = await setupTestServer();
    try {
      const response = await performPairRequest(ctx.port, deviceId, { claimedName: "QA Sim" });
      expect(response).toMatchObject({
        type: "pair_result",
        success: false,
        reason: "pair_pending",
      });
      await vi.waitFor(() => {
        expect(enqueueAnnounceMock).toHaveBeenCalledTimes(1);
      });
      const call = enqueueAnnounceMock.mock.calls[0]?.[0] as {
        key?: string;
        item?: { prompt?: string; origin?: { channel?: string; to?: string } };
      };
      expect(call?.key).toBe("agent:main:main");
      expect(call?.item?.prompt).toBe(
        `New device pending approval: qa sim (iOS/iPhone) [deviceId: ${deviceId}]`,
      );
      expect(call?.item?.origin).toEqual({ channel: "clawline", to: "agent:main:main" });
      expect(gatewayCallMock).not.toHaveBeenCalled();
    } finally {
      await ctx.cleanup();
    }
  });

  it("does not bootstrap admin when no admin exists", async () => {
    const ctx = await setupTestServer();
    const deviceId = randomUUID();
    try {
      const response = await performPairRequest(ctx.port, deviceId, { claimedName: "Flynn " });
      expect(response).toMatchObject({ success: false, reason: "pair_pending" });
      const allowlist = JSON.parse(await fs.readFile(ctx.allowlistPath, "utf8")) as {
        entries: AllowlistEntry[];
      };
      const entry = allowlist.entries.find((item) => item.deviceId === deviceId);
      expect(entry).toBeUndefined();
    } finally {
      await ctx.cleanup();
    }
  });

  it("writes pending entries for non-admin claimants when no admin exists", async () => {
    const ctx = await setupTestServer();
    const deviceId = randomUUID();
    try {
      const response = await performPairRequest(ctx.port, deviceId, { claimedName: "QA Sim" });
      expect(response).toMatchObject({
        success: false,
        reason: "pair_pending",
      });
      const pending = JSON.parse(await fs.readFile(ctx.pendingPath, "utf8")) as {
        entries: { deviceId: string }[];
      };
      expect(pending.entries.some((entry) => entry.deviceId === deviceId)).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  });

  it("stores uploaded assets on disk", async () => {
    const deviceId = randomUUID();
    const entry = createAllowlistEntry({
      deviceId,
      isAdmin: true,
      tokenDelivered: false,
      lastSeenAt: null,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const pairResponse = await performPairRequest(ctx.port, deviceId, { claimedName: "Flynn" });
      expect(pairResponse.success).toBe(true);
      const token = pairResponse.token as string;
      const bytes = Buffer.from("sample-image-bytes");
      const upload = await uploadAsset(ctx.port, token, bytes, "image/png");
      expect(upload.assetId).toMatch(/^a_/);
      const assetPath = path.join(ctx.mediaPath, "assets", upload.assetId);
      const stored = await fs.readFile(assetPath);
      expect(stored.equals(bytes)).toBe(true);
    } finally {
      await ctx.cleanup();
    }
  });

  it("sniffs image mime type for octet-stream uploads", async () => {
    const deviceId = randomUUID();
    const entry = createAllowlistEntry({
      deviceId,
      isAdmin: true,
      tokenDelivered: false,
      lastSeenAt: null,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const pairResponse = await performPairRequest(ctx.port, deviceId, { claimedName: "Flynn" });
      expect(pairResponse.success).toBe(true);
      const token = pairResponse.token as string;
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

      const upload = await uploadAsset(ctx.port, token, pngBytes, "application/octet-stream");
      expect(upload.mimeType).toBe("image/png");

      const response = await fetch(`http://127.0.0.1:${ctx.port}/download/${upload.assetId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("image/png");
    } finally {
      await ctx.cleanup();
    }
  });

  it("keeps outbound interactive HTML attachments inline as documents", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const descriptor = {
        version: 1,
        html: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div>Hello</div></body></html>',
        metadata: { title: "Card", height: 80 },
      };
      const base64 = Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64");

      const result = await ctx.server.sendMessage({
        target: entry.userId,
        text: "",
        attachments: [
          {
            data: base64,
            mimeType: "application/vnd.clawline.interactive-html+json",
          },
        ],
      });

      expect(result.attachments).toEqual([
        {
          type: "document",
          mimeType: "application/vnd.clawline.interactive-html+json",
          data: base64,
        },
      ]);
      expect(result.assetIds).toEqual([]);
    } finally {
      await ctx.cleanup();
    }
  });

  it("rejects outbound interactive HTML attachments with malformed descriptor JSON", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const base64 = Buffer.from(String.raw`{"version":1,"html":"bad \u201\V"}`, "utf8").toString(
        "base64",
      );

      await expect(
        ctx.server.sendMessage({
          target: entry.userId,
          text: "",
          attachments: [
            {
              data: base64,
              mimeType: "application/vnd.clawline.interactive-html+json",
            },
          ],
        }),
      ).rejects.toThrow(/interactive HTML descriptor is not valid base64 JSON/i);
    } finally {
      await ctx.cleanup();
    }
  });

  it("rejects outbound interactive HTML attachments with non-base64 suffixes", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const descriptor = {
        version: 1,
        html: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div>Hello</div></body></html>',
      };
      const base64 = Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64");

      await expect(
        ctx.server.sendMessage({
          target: entry.userId,
          text: "",
          attachments: [
            {
              data: `${base64}!`,
              mimeType: "application/vnd.clawline.interactive-html+json",
            },
          ],
        }),
      ).rejects.toThrow(/interactive HTML descriptor is not valid base64 JSON/i);
    } finally {
      await ctx.cleanup();
    }
  });

  it("rejects outbound interactive HTML attachments with custom CSP meta", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const descriptor = {
        version: 1,
        html: '<!doctype html><html><head><meta name=viewport content="width=device-width, initial-scale=1"><meta content="default-src \'none\'" http-equiv=Content-Security-Policy></head><body>Nope</body></html>',
      };
      const base64 = Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64");

      await expect(
        ctx.server.sendMessage({
          target: entry.userId,
          text: "",
          attachments: [
            {
              data: base64,
              mimeType: "application/vnd.clawline.interactive-html+json",
            },
          ],
        }),
      ).rejects.toThrow(/must not include custom CSP/i);
    } finally {
      await ctx.cleanup();
    }
  });

  it("rejects outbound interactive HTML data URIs with malformed descriptor JSON", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const base64 = Buffer.from(String.raw`{"version":1,"html":"bad \u201\V"}`, "utf8").toString(
        "base64",
      );

      await expect(
        ctx.server.sendMessage({
          target: entry.userId,
          text: "",
          attachments: [
            {
              data: `data:application/vnd.clawline.interactive-html+json;base64,${base64}`,
            },
          ],
        }),
      ).rejects.toThrow(/interactive HTML descriptor is not valid base64 JSON/i);
    } finally {
      await ctx.cleanup();
    }
  });

  it("keeps existing best-effort behavior when an unrelated mixed attachment fails", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const descriptor = {
        version: 1,
        html: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div>Hello</div></body></html>',
      };
      const base64 = Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64");
      const oversizedImage = Buffer.alloc(8_000_001, 1).toString("base64");

      const result = await ctx.server.sendMessage({
        target: entry.userId,
        text: "fallback text",
        attachments: [
          {
            data: base64,
            mimeType: "application/vnd.clawline.interactive-html+json",
          },
          {
            data: oversizedImage,
            mimeType: "image/png",
          },
        ],
      });

      expect(result.attachments).toEqual([]);
      expect(result.assetIds).toEqual([]);
    } finally {
      await ctx.cleanup();
    }
  });

  it("accepts raw JSON terminal descriptors in outbound attachments", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const descriptor = {
        terminalSessionId: `term_${randomUUID()}`,
        title: "Term",
      };
      const jsonPayload = JSON.stringify(descriptor);
      const expectedBase64 = Buffer.from(jsonPayload, "utf8").toString("base64");

      const result = await ctx.server.sendMessage({
        target: entry.userId,
        text: "",
        attachments: [
          {
            data: jsonPayload,
            mimeType: "application/vnd.clawline.terminal-session+json",
          },
        ],
      });

      expect(result.attachments).toEqual([
        {
          type: "document",
          mimeType: "application/vnd.clawline.terminal-session+json",
          data: expectedBase64,
        },
      ]);
      expect(result.assetIds).toEqual([]);
    } finally {
      await ctx.cleanup();
    }
  });

  it("stores oversized outbound image attachments as asset-backed messages and replays them without inline data", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const largeBuffer = Buffer.alloc(300_000, 7);
      const result = await ctx.server.sendMessage({
        target: entry.userId,
        text: "",
        attachments: [
          {
            data: largeBuffer.toString("base64"),
            mimeType: "image/png",
          },
        ],
      });

      expect(result.attachments).toHaveLength(1);
      expect(result.attachments?.[0]).toMatchObject({
        type: "asset",
        assetId: expect.stringMatching(/^a_/),
      });
      const firstAttachment = result.attachments?.[0];
      expect(firstAttachment?.type).toBe("asset");
      const assetId = firstAttachment?.type === "asset" ? firstAttachment.assetId : undefined;
      expect(result.assetIds).toEqual([assetId]);
      expect(assetId).toBeTruthy();
      const assetPath = path.join(ctx.mediaPath, "assets", assetId as string);
      const stored = await fs.readFile(assetPath);
      expect(stored.equals(largeBuffer)).toBe(true);

      const pair = await performPairRequest(ctx.port, entry.deviceId);
      const { ws, queue } = await authenticateDeviceWithQueue(
        ctx.port,
        entry.deviceId,
        pair.token as string,
      );
      try {
        const replay = await queue.next();
        expect(replay).toMatchObject({
          type: "message",
          attachments: [{ type: "asset", assetId }],
        });
      } finally {
        queue.dispose();
        ws.terminate();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await ctx.cleanup();
    }
  });

  it("canonicalizes legacy replay attachments that mix asset ids with inline image payloads", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const largeBuffer = Buffer.alloc(300_000, 9);
      const result = await ctx.server.sendMessage({
        target: entry.userId,
        text: "",
        attachments: [
          {
            data: largeBuffer.toString("base64"),
            mimeType: "image/png",
          },
        ],
      });
      const firstAttachment = result.attachments?.[0];
      expect(firstAttachment?.type).toBe("asset");
      const assetId = firstAttachment?.type === "asset" ? firstAttachment.assetId : "";
      const dbPath = path.join(path.dirname(ctx.allowlistPath), "clawline.sqlite");
      const db = new BetterSqlite3(dbPath);
      try {
        const row = db
          .prepare(`SELECT id, payloadJson FROM events ORDER BY sequence DESC LIMIT 1`)
          .get() as { id: string; payloadJson: string };
        const payload = JSON.parse(row.payloadJson) as {
          attachments?: Array<Record<string, unknown>>;
        };
        payload.attachments = [
          {
            type: "image",
            mimeType: "image/png",
            data: Buffer.from("legacy-inline").toString("base64"),
            assetId,
          },
        ];
        const payloadJson = JSON.stringify(payload);
        db.prepare(`UPDATE events SET payloadJson = ?, payloadBytes = ? WHERE id = ?`).run(
          payloadJson,
          Buffer.byteLength(payloadJson, "utf8"),
          row.id,
        );
      } finally {
        db.close();
      }

      const pair = await performPairRequest(ctx.port, entry.deviceId);
      const { ws, queue } = await authenticateDeviceWithQueue(
        ctx.port,
        entry.deviceId,
        pair.token as string,
      );
      try {
        const replay = await queue.next();
        expect(replay.attachments).toEqual([{ type: "asset", assetId }]);
      } finally {
        queue.dispose();
        ws.terminate();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await ctx.cleanup();
    }
  });

  it("replays the latest 20 messages per subscribed stream independently", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      userId: "flynn",
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const personalSessionKey = "agent:main:clawline:flynn:main";
      const globalSessionKey = "agent:main:main";
      for (let index = 1; index <= 25; index += 1) {
        await ctx.server.sendMessage({
          target: entry.userId,
          text: `personal ${index}`,
          sessionKey: personalSessionKey,
        });
      }
      for (let index = 1; index <= 5; index += 1) {
        await ctx.server.sendMessage({
          target: entry.userId,
          text: `global ${index}`,
          sessionKey: globalSessionKey,
        });
      }

      const pair = await performPairRequest(ctx.port, entry.deviceId);
      const { ws, queue, auth } = await authenticateDeviceWithQueue(
        ctx.port,
        entry.deviceId,
        pair.token as string,
      );
      try {
        expect(auth.replayTruncated).toBe(true);
        const replayed = await collectQueuedMessagesUntilIdle(queue);
        const messages = replayed.filter((value) => value.type === "message");
        const personalMessages = messages.filter(
          (value) => value.sessionKey === personalSessionKey,
        );
        const globalMessages = messages.filter((value) => value.sessionKey === globalSessionKey);

        expect(messages).toHaveLength(25);
        expect(personalMessages.map((value) => value.content)).toEqual(
          Array.from({ length: 20 }, (_, index) => `personal ${index + 6}`),
        );
        expect(globalMessages.map((value) => value.content)).toEqual(
          Array.from({ length: 5 }, (_, index) => `global ${index + 1}`),
        );
        expect(messages.map((value) => value.content)).toEqual([
          ...Array.from({ length: 20 }, (_, index) => `personal ${index + 6}`),
          ...Array.from({ length: 5 }, (_, index) => `global ${index + 1}`),
        ]);
      } finally {
        queue.dispose();
        ws.terminate();
      }
    } finally {
      await ctx.cleanup();
    }
  });

  it("uses per-stream replay cursors and legacy fallback only for the owning stream", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      userId: "flynn",
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const personalSessionKey = "agent:main:clawline:flynn:main";
      const globalSessionKey = "agent:main:main";
      const personal1 = await ctx.server.sendMessage({
        target: entry.userId,
        text: "personal 1",
        sessionKey: personalSessionKey,
      });
      await ctx.server.sendMessage({
        target: entry.userId,
        text: "personal 2",
        sessionKey: personalSessionKey,
      });
      const global1 = await ctx.server.sendMessage({
        target: entry.userId,
        text: "global 1",
        sessionKey: globalSessionKey,
      });
      await ctx.server.sendMessage({
        target: entry.userId,
        text: "global 2",
        sessionKey: globalSessionKey,
      });

      const pair = await performPairRequest(ctx.port, entry.deviceId);
      const { ws, queue, auth } = await authenticateDeviceWithQueue(
        ctx.port,
        entry.deviceId,
        pair.token as string,
        {
          authPayload: {
            lastMessageId: global1.messageId,
            replayCursorsBySessionKey: {
              [personalSessionKey]: personal1.messageId,
            },
          },
        },
      );
      try {
        expect(auth.historyReset).toBe(false);
        expect(auth.replayCount).toBe(2);
        const replayed = await collectQueuedMessagesUntilIdle(queue);
        const messages = replayed.filter((value) => value.type === "message");
        expect(messages.map((value) => value.content)).toEqual(["personal 2", "global 2"]);
        expect(replayed.some((value) => value.type === "sync_complete")).toBe(true);
      } finally {
        queue.dispose();
        ws.terminate();
      }
    } finally {
      await ctx.cleanup();
    }
  });

  it("treats invalid per-stream cursors as latest-window recovery for only that stream", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      userId: "flynn",
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const personalSessionKey = "agent:main:clawline:flynn:main";
      const globalSessionKey = "agent:main:main";
      const personal1 = await ctx.server.sendMessage({
        target: entry.userId,
        text: "personal 1",
        sessionKey: personalSessionKey,
      });
      await ctx.server.sendMessage({
        target: entry.userId,
        text: "personal 2",
        sessionKey: personalSessionKey,
      });
      const global1 = await ctx.server.sendMessage({
        target: entry.userId,
        text: "global 1",
        sessionKey: globalSessionKey,
      });
      await ctx.server.sendMessage({
        target: entry.userId,
        text: "global 2",
        sessionKey: globalSessionKey,
      });

      const pair = await performPairRequest(ctx.port, entry.deviceId);
      const { ws, queue, auth } = await authenticateDeviceWithQueue(
        ctx.port,
        entry.deviceId,
        pair.token as string,
        {
          authPayload: {
            lastMessageId: global1.messageId,
            replayCursorsBySessionKey: {
              [personalSessionKey]: personal1.messageId,
              [globalSessionKey]: `s_${randomUUID()}`,
            },
          },
        },
      );
      try {
        expect(auth.historyReset).toBe(true);
        expect(auth.replayCount).toBe(3);
        const replayed = await collectQueuedMessagesUntilIdle(queue);
        const messages = replayed.filter((value) => value.type === "message");
        expect(messages.map((value) => value.content)).toEqual([
          "personal 2",
          "global 1",
          "global 2",
        ]);
      } finally {
        queue.dispose();
        ws.terminate();
      }
    } finally {
      await ctx.cleanup();
    }
  });

  it("marks replay history reset when the supplied anchor is stale", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      userId: "flynn",
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const pair = await performPairRequest(ctx.port, entry.deviceId);
      const { ws, auth } = await authenticateDevice(
        ctx.port,
        entry.deviceId,
        pair.token as string,
        {
          authPayload: { lastMessageId: `s_${randomUUID()}` },
        },
      );
      expect(auth.historyReset).toBe(true);
      ws.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("marks replay history reset when the supplied anchor belongs to another user", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      userId: "flynn",
      isAdmin: true,
      tokenDelivered: true,
    });
    const otherEntry = createAllowlistEntry({
      deviceId: randomUUID(),
      userId: "other",
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry, otherEntry]);
    try {
      const otherMessage = await ctx.server.sendMessage({
        target: otherEntry.userId,
        text: "other global",
        sessionKey: "agent:main:main",
      });

      const pair = await performPairRequest(ctx.port, entry.deviceId);
      const { ws, auth } = await authenticateDevice(
        ctx.port,
        entry.deviceId,
        pair.token as string,
        {
          authPayload: { lastMessageId: otherMessage.messageId },
        },
      );
      expect(auth.historyReset).toBe(true);
      ws.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("stops replay immediately when the socket closes during initial replay sends", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      userId: "flynn",
      isAdmin: true,
      tokenDelivered: true,
    });
    const info = vi.fn();
    const logger: Logger = {
      info,
      warn: () => {},
      error: () => {},
    };
    const ctx = await setupTestServer([entry], { logger });
    try {
      for (let index = 1; index <= 5; index += 1) {
        await ctx.server.sendMessage({
          target: entry.userId,
          text: `replay ${index}`,
          sessionKey: "agent:main:clawline:flynn:main",
        });
      }

      const pair = await performPairRequest(ctx.port, entry.deviceId);
      const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws`);
      await waitForOpen(ws);
      await new Promise<void>((resolve, reject) => {
        ws.send(
          JSON.stringify({
            type: "auth",
            protocolVersion: PROTOCOL_VERSION,
            deviceId: entry.deviceId,
            token: pair.token,
          }),
          (err) => {
            if (err) {
              reject(err);
              return;
            }
            ws.terminate();
            resolve();
          },
        );
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const replaySendLogs = info.mock.calls.filter(([event]) => event === "replay_send");
      expect(replaySendLogs).toHaveLength(0);
    } finally {
      await ctx.cleanup();
    }
  });

  it("rejects outbound terminal descriptors missing terminalSessionId", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const descriptor = {
        version: 1,
        title: "Term",
      };
      const base64 = Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64");

      await expect(
        ctx.server.sendMessage({
          target: entry.userId,
          text: "",
          attachments: [
            {
              data: base64,
              mimeType: "application/vnd.clawline.terminal-session+json",
            },
          ],
        }),
      ).rejects.toThrow("terminal session descriptor is invalid");
    } finally {
      await ctx.cleanup();
    }
  });

  it("rejects version 2 outbound terminal descriptors missing destination.address", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const descriptor = {
        version: 2,
        terminalSessionId: `term_${randomUUID()}`,
        title: "Term",
      };
      const base64 = Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64");

      await expect(
        ctx.server.sendMessage({
          target: entry.userId,
          text: "",
          attachments: [
            {
              data: base64,
              mimeType: "application/vnd.clawline.terminal-session+json",
            },
          ],
        }),
      ).rejects.toThrow("terminal session descriptor is invalid");
    } finally {
      await ctx.cleanup();
    }
  });

  it("accepts data URI terminal descriptors without blocking on tmux startup", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry], {
      terminalTmux: {
        mode: "ssh",
        sshTarget: "nonexistent-host.invalid",
      },
    });
    try {
      const descriptor = {
        terminalSessionId: `term_${randomUUID()}`,
        title: "Term",
      };
      const base64 = Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64");
      const dataUri = `data:application/vnd.clawline.terminal-session+json;base64,${base64}`;

      const result = await ctx.server.sendMessage({
        target: entry.userId,
        text: "terminal",
        attachments: [
          {
            data: dataUri,
            mimeType: "application/vnd.clawline.terminal-session+json",
          },
        ],
      });

      expect(result.attachments).toEqual([
        {
          type: "document",
          mimeType: "application/vnd.clawline.terminal-session+json",
          data: base64,
        },
      ]);
      expect(result.assetIds).toEqual([]);
    } finally {
      await ctx.cleanup();
    }
  });

  it("accepts data URI terminal descriptors with extra mime parameters", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry], {
      terminalTmux: {
        mode: "ssh",
        sshTarget: "nonexistent-host.invalid",
      },
    });
    try {
      const descriptor = {
        terminalSessionId: `term_${randomUUID()}`,
        title: "Term",
      };
      const base64 = Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64");
      const dataUri =
        "data:application/vnd.clawline.terminal-session+json;charset=utf-8;base64," + base64;

      const result = await ctx.server.sendMessage({
        target: entry.userId,
        text: "terminal",
        attachments: [
          {
            data: dataUri,
            mimeType: "application/vnd.clawline.terminal-session+json",
          },
        ],
      });

      expect(result.attachments).toEqual([
        {
          type: "document",
          mimeType: "application/vnd.clawline.terminal-session+json",
          data: base64,
        },
      ]);
      expect(result.assetIds).toEqual([]);
    } finally {
      await ctx.cleanup();
    }
  });

  it("sends outbound document attachments even when inbound processing is still running", async () => {
    const deviceId = randomUUID();
    const entry = createAllowlistEntry({
      deviceId,
      isAdmin: true,
      tokenDelivered: false,
      lastSeenAt: null,
    });
    const ctx = await setupTestServer([entry], {
      replyResolver: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        return { text: "slow" };
      },
    });

    let ws: WebSocket | null = null;
    try {
      const pair = await performPairRequest(ctx.port, deviceId, { claimedName: "Flynn" });
      expect(pair.success).toBe(true);
      const authed = await authenticateDevice(ctx.port, deviceId, pair.token as string);
      ws = authed.ws;

      const inboundId = `c_${randomUUID()}`;
      ws.send(
        JSON.stringify({
          type: "message",
          id: inboundId,
          content: "trigger slow reply",
        }),
      );
      const ack = await waitForMessage(ws);
      expect(ack).toMatchObject({ type: "ack", id: inboundId });

      const descriptor = {
        version: 1,
        html: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><button>Hi</button></body></html>',
        metadata: { title: "Test" },
      };
      const base64 = Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64");

      const outbound = await Promise.race([
        ctx.server.sendMessage({
          target: entry.userId,
          text: "",
          attachments: [
            {
              data: base64,
              mimeType: "application/vnd.clawline.interactive-html+json",
            },
          ],
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("outbound_send_timeout")), 800),
        ),
      ]);

      expect(outbound.attachments).toEqual([
        {
          type: "document",
          mimeType: "application/vnd.clawline.interactive-html+json",
          data: base64,
        },
      ]);
    } finally {
      ws?.terminate();
      await ctx.cleanup();
    }
  });

  it("does not crash outbound sends when mediaUrl is an invalid local path", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const result = await ctx.server.sendMessage({
        target: entry.userId,
        text: "fallback text",
        mediaUrl: "/tmp/not-http-url.png",
      });
      expect(result.attachments).toEqual([]);
      expect(result.assetIds).toEqual([]);
    } finally {
      await ctx.cleanup();
    }
  });

  it("does not deliver admin channel messages to non-admin sessions", async () => {
    const adminDeviceId = randomUUID();
    const userDeviceId = randomUUID();
    const baseEntry = {
      claimedName: "Test Device",
      deviceInfo: {
        platform: "iOS",
        model: "iPhone",
        osVersion: "17.0",
        appVersion: "1.0",
      },
      tokenDelivered: true,
      createdAt: Date.now() - 1_000,
      lastSeenAt: Date.now() - 500,
    };
    const ctx = await setupTestServer([
      {
        ...baseEntry,
        deviceId: adminDeviceId,
        claimedName: "Flynn",
        userId: "flynn",
        isAdmin: true,
      },
      {
        ...baseEntry,
        deviceId: userDeviceId,
        claimedName: "QA Sim",
        userId: "qa_sim",
        isAdmin: false,
      },
    ]);
    const cleanupWs = async (...sockets: WebSocket[]) => {
      sockets.forEach((ws) => {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      });
    };
    try {
      const adminPair = await performPairRequest(ctx.port, adminDeviceId);
      const userPair = await performPairRequest(ctx.port, userDeviceId);
      const { ws: adminWs } = await authenticateDevice(
        ctx.port,
        adminDeviceId,
        adminPair.token as string,
      );
      const { ws: userWs } = await authenticateDevice(
        ctx.port,
        userDeviceId,
        userPair.token as string,
      );

      const received: ParsedWsFrame[] = [];
      const listener = (data: WebSocket.RawData) => {
        received.push(JSON.parse(decodeRawData(data)));
      };
      userWs.on("message", listener);
      await new Promise((resolve) => setTimeout(resolve, 20));
      received.length = 0;

      adminWs.send(
        JSON.stringify({
          type: "message",
          id: `c_${randomUUID()}`,
          sessionKey: "agent:main:main",
          content: "secret-admin-update",
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received).toHaveLength(0);
      userWs.off("message", listener);
      await cleanupWs(adminWs, userWs);
    } finally {
      await ctx.cleanup();
    }
  });

  it("prefers sessionKey routing for admin messages", async () => {
    const adminDeviceId = randomUUID();
    const userDeviceId = randomUUID();
    const baseEntry = {
      claimedName: "Test Device",
      deviceInfo: {
        platform: "iOS",
        model: "iPhone",
        osVersion: "17.0",
        appVersion: "1.0",
      },
      tokenDelivered: true,
      createdAt: Date.now() - 1_000,
      lastSeenAt: Date.now() - 500,
    };
    const ctx = await setupTestServer([
      {
        ...baseEntry,
        deviceId: adminDeviceId,
        claimedName: "Flynn",
        userId: "flynn",
        isAdmin: true,
      },
      {
        ...baseEntry,
        deviceId: userDeviceId,
        claimedName: "QA Sim",
        userId: "qa_sim",
        isAdmin: false,
      },
    ]);
    const cleanupWs = async (...sockets: WebSocket[]) => {
      sockets.forEach((ws) => {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      });
    };
    try {
      const adminPair = await performPairRequest(ctx.port, adminDeviceId);
      const userPair = await performPairRequest(ctx.port, userDeviceId);
      const { ws: adminWs } = await authenticateDevice(
        ctx.port,
        adminDeviceId,
        adminPair.token as string,
      );
      const { ws: userWs } = await authenticateDevice(
        ctx.port,
        userDeviceId,
        userPair.token as string,
      );

      const received: ParsedWsFrame[] = [];
      const listener = (data: WebSocket.RawData) => {
        received.push(JSON.parse(decodeRawData(data)));
      };
      userWs.on("message", listener);
      await new Promise((resolve) => setTimeout(resolve, 20));
      received.length = 0;

      adminWs.send(
        JSON.stringify({
          type: "message",
          id: `c_${randomUUID()}`,
          sessionKey: "agent:main:main",
          content: "secret-admin-update",
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received).toHaveLength(0);
      userWs.off("message", listener);
      await cleanupWs(adminWs, userWs);
    } finally {
      await ctx.cleanup();
    }
  });

  it("accepts messages without sessionKey for legacy clients", async () => {
    const deviceId = randomUUID();
    const ctx = await setupTestServer([
      {
        deviceId,
        claimedName: "Legacy Client",
        deviceInfo: {
          platform: "iOS",
          model: "iPhone",
          osVersion: "17.0",
          appVersion: "1.0",
        },
        userId: "legacy",
        isAdmin: false,
        tokenDelivered: true,
        createdAt: Date.now() - 10_000,
        lastSeenAt: Date.now() - 5_000,
      },
    ]);
    try {
      const pair = await performPairRequest(ctx.port, deviceId);
      const { ws } = await authenticateDevice(ctx.port, deviceId, pair.token as string);
      const messageId = `c_${randomUUID()}`;
      const firstPromise = waitForMessage(ws);
      ws.send(
        JSON.stringify({
          type: "message",
          id: messageId,
          content: "hello",
        }),
      );
      const first = await firstPromise;
      const ack = first?.type === "ack" ? first : await waitForMessage(ws);
      expect(ack).toMatchObject({ type: "ack", id: messageId });
      ws.terminate();
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      await ctx.cleanup();
    }
  });

  it("includes isAdmin in auth_result based on allowlist entry", async () => {
    const adminDeviceId = randomUUID();
    const userDeviceId = randomUUID();
    const baseEntry = {
      claimedName: "QA Sim",
      deviceInfo: {
        platform: "iOS",
        model: "iPhone",
      },
      createdAt: Date.now() - 10_000,
      lastSeenAt: Date.now() - 5_000,
      tokenDelivered: true,
    };
    const ctx = await setupTestServer([
      {
        ...baseEntry,
        deviceId: adminDeviceId,
        claimedName: "Flynn",
        userId: "flynn",
        isAdmin: true,
      },
      {
        ...baseEntry,
        deviceId: userDeviceId,
        claimedName: "QA Sim",
        userId: "qa_sim",
        isAdmin: false,
      },
    ]);
    try {
      const adminPair = await performPairRequest(ctx.port, adminDeviceId);
      const userPair = await performPairRequest(ctx.port, userDeviceId);
      const {
        ws: adminWs,
        auth: adminAuth,
        streamSnapshot: adminStreamSnapshot,
        sessionInfo: adminSessionInfo,
      } = await authenticateDevice(ctx.port, adminDeviceId, adminPair.token as string);
      const {
        ws: userWs,
        auth: userAuth,
        streamSnapshot: userStreamSnapshot,
        sessionInfo: userSessionInfo,
      } = await authenticateDevice(ctx.port, userDeviceId, userPair.token as string);
      expect(adminAuth.isAdmin).toBe(true);
      expect(userAuth.isAdmin).toBe(false);
      expect(adminAuth.features).toContain("session_info");
      expect(userAuth.features).toContain("session_info");
      expect((adminSessionInfo as { sessionKeys?: string[] } | null)?.sessionKeys).toEqual([
        "agent:main:clawline:flynn:main",
        "agent:main:main",
      ]);
      expect((userSessionInfo as { sessionKeys?: string[] } | null)?.sessionKeys).toEqual([
        "agent:main:clawline:qa_sim:main",
      ]);
      expect(adminStreamSnapshot.streams).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionKey: "agent:main:clawline:flynn:main",
            displayName: "Personal",
            kind: "main",
          }),
          expect.objectContaining({
            sessionKey: "agent:main:main",
            displayName: "Global DM",
            kind: "global_dm",
          }),
        ]),
      );
      expect(userStreamSnapshot.streams).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionKey: "agent:main:clawline:qa_sim:main",
            displayName: "Personal",
            kind: "main",
          }),
        ]),
      );
      adminWs.terminate();
      userWs.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("echoes terminal_bubbles_v1 in auth_result when client advertises support", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      userId: "feature_user",
      isAdmin: false,
      tokenDelivered: false,
      lastSeenAt: null,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const pair = await performPairRequest(ctx.port, entry.deviceId);
      const { ws, auth } = await authenticateDevice(
        ctx.port,
        entry.deviceId,
        pair.token as string,
        {
          authPayload: {
            clientFeatures: ["terminal_bubbles_v1"],
            client: {
              id: "clawline-ios-tests",
              features: ["terminal_bubbles_v1"],
            },
          },
        },
      );
      expect(auth.features).toEqual(
        expect.arrayContaining(["session_info", "terminal_bubbles_v1"]),
      );
      ws.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("includes stream read and tail state snapshots in auth_result", async () => {
    const primaryDeviceId = randomUUID();
    const secondaryDeviceId = randomUUID();
    const baseEntry = {
      claimedName: "QA Sim",
      deviceInfo: {
        platform: "iOS",
        model: "iPhone",
      },
      userId: "snapshot_user",
      isAdmin: false,
      tokenDelivered: true,
      createdAt: Date.now() - 10_000,
      lastSeenAt: Date.now() - 5_000,
    };
    const ctx = await setupTestServer(
      [
        {
          ...baseEntry,
          deviceId: primaryDeviceId,
        },
        {
          ...baseEntry,
          deviceId: secondaryDeviceId,
        },
      ],
      {
        replyResolver: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          return { text: "slow" };
        },
      },
    );
    try {
      const primaryPair = await performPairRequest(ctx.port, primaryDeviceId);
      const secondaryPair = await performPairRequest(ctx.port, secondaryDeviceId);
      const {
        ws: primaryWs,
        queue: primaryQueue,
        streamSnapshot,
      } = await authenticateDeviceWithQueue(ctx.port, primaryDeviceId, primaryPair.token as string);
      const mainStream = (
        streamSnapshot.streams as Array<{ kind: string; sessionKey: string }>
      ).find((stream) => stream.kind === "main");
      expect(mainStream?.sessionKey).toBe("agent:main:clawline:snapshot_user:main");

      const clientMessageId = `c_${randomUUID()}`;
      primaryWs.send(
        JSON.stringify({
          type: "message",
          id: clientMessageId,
          content: "snapshot tail",
          attachments: [],
          sessionKey: mainStream?.sessionKey,
        }),
      );

      await waitForQueuedMessageWithTimeout(
        primaryQueue,
        (value) =>
          typeof value === "object" &&
          value !== null &&
          (value as { type?: string; id?: string }).type === "ack" &&
          (value as { id?: string }).id === clientMessageId,
      );
      const echoed = (await waitForQueuedMessageWithTimeout(
        primaryQueue,
        (value) =>
          typeof value === "object" &&
          value !== null &&
          (value as { type?: string; role?: string; content?: string }).type === "message" &&
          (value as { role?: string }).role === "user" &&
          (value as { content?: string }).content === "snapshot tail",
      )) as { id: string };
      await waitForQueuedMessageWithTimeout(
        primaryQueue,
        (value) =>
          typeof value === "object" &&
          value !== null &&
          (
            value as {
              type?: string;
              sessionKey?: string;
              lastMessageId?: string;
              lastMessageRole?: string;
            }
          ).type === "stream_tail_state" &&
          (value as { sessionKey?: string }).sessionKey === mainStream?.sessionKey &&
          (value as { lastMessageId?: string }).lastMessageId === echoed.id &&
          (value as { lastMessageRole?: string }).lastMessageRole === "user",
      );

      primaryWs.send(
        JSON.stringify({
          type: "stream_read",
          sessionKey: mainStream?.sessionKey,
          lastReadMessageId: echoed.id,
        }),
      );
      await waitForQueuedMessageWithTimeout(
        primaryQueue,
        (value) =>
          typeof value === "object" &&
          value !== null &&
          (value as { type?: string; sessionKey?: string; lastReadMessageId?: string }).type ===
            "stream_read_state" &&
          (value as { sessionKey?: string }).sessionKey === mainStream?.sessionKey &&
          (value as { lastReadMessageId?: string }).lastReadMessageId === echoed.id,
      );

      const { ws: secondaryWs, auth: secondaryAuth } = await authenticateDevice(
        ctx.port,
        secondaryDeviceId,
        secondaryPair.token as string,
      );
      expect(secondaryAuth.streamReadStates).toEqual({
        [mainStream?.sessionKey ?? ""]: echoed.id,
      });
      expect(secondaryAuth.streamTailStates).toEqual({
        [mainStream?.sessionKey ?? ""]: {
          lastMessageId: echoed.id,
          lastMessageRole: "user",
        },
      });

      primaryQueue.dispose();
      primaryWs.terminate();
      secondaryWs.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("broadcasts stream read and tail state updates to sibling devices", async () => {
    const primaryDeviceId = randomUUID();
    const secondaryDeviceId = randomUUID();
    const baseEntry = {
      claimedName: "QA Sim",
      deviceInfo: {
        platform: "iOS",
        model: "iPhone",
      },
      userId: "sync_user",
      isAdmin: false,
      tokenDelivered: true,
      createdAt: Date.now() - 10_000,
      lastSeenAt: Date.now() - 5_000,
    };
    const ctx = await setupTestServer(
      [
        {
          ...baseEntry,
          deviceId: primaryDeviceId,
        },
        {
          ...baseEntry,
          deviceId: secondaryDeviceId,
        },
      ],
      {
        replyResolver: async () => {
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          return { text: "slow" };
        },
      },
    );
    try {
      const primaryPair = await performPairRequest(ctx.port, primaryDeviceId);
      const secondaryPair = await performPairRequest(ctx.port, secondaryDeviceId);
      const {
        ws: primaryWs,
        queue: primaryQueue,
        streamSnapshot: primarySnapshot,
      } = await authenticateDeviceWithQueue(ctx.port, primaryDeviceId, primaryPair.token as string);
      const { ws: secondaryWs, queue: secondaryQueue } = await authenticateDeviceWithQueue(
        ctx.port,
        secondaryDeviceId,
        secondaryPair.token as string,
      );
      const mainStream = (
        primarySnapshot.streams as Array<{ kind: string; sessionKey: string }>
      ).find((stream) => stream.kind === "main");
      expect(mainStream?.sessionKey).toBe("agent:main:clawline:sync_user:main");

      const clientMessageId = `c_${randomUUID()}`;
      primaryWs.send(
        JSON.stringify({
          type: "message",
          id: clientMessageId,
          content: "live sync",
          attachments: [],
          sessionKey: mainStream?.sessionKey,
        }),
      );

      await waitForQueuedMessageWithTimeout(
        primaryQueue,
        (value) =>
          typeof value === "object" &&
          value !== null &&
          (value as { type?: string; id?: string }).type === "ack" &&
          (value as { id?: string }).id === clientMessageId,
      );
      const primaryEcho = (await waitForQueuedMessageWithTimeout(
        primaryQueue,
        (value) =>
          typeof value === "object" &&
          value !== null &&
          (value as { type?: string; role?: string; content?: string }).type === "message" &&
          (value as { role?: string }).role === "user" &&
          (value as { content?: string }).content === "live sync",
      )) as { id: string };
      const siblingTail = await waitForQueuedMessageWithTimeout(
        secondaryQueue,
        (value) =>
          typeof value === "object" &&
          value !== null &&
          (
            value as {
              type?: string;
              sessionKey?: string;
              lastMessageId?: string;
              lastMessageRole?: string;
            }
          ).type === "stream_tail_state" &&
          (value as { sessionKey?: string }).sessionKey === mainStream?.sessionKey &&
          (value as { lastMessageRole?: string }).lastMessageRole === "user",
      );
      expect(siblingTail).toMatchObject({
        type: "stream_tail_state",
        sessionKey: mainStream?.sessionKey,
        lastMessageId: primaryEcho.id,
        lastMessageRole: "user",
      });

      primaryWs.send(
        JSON.stringify({
          type: "stream_read",
          sessionKey: mainStream?.sessionKey,
          lastReadMessageId: primaryEcho.id,
        }),
      );
      const siblingRead = await waitForQueuedMessageWithTimeout(
        secondaryQueue,
        (value) =>
          typeof value === "object" &&
          value !== null &&
          (value as { type?: string; sessionKey?: string; lastReadMessageId?: string }).type ===
            "stream_read_state" &&
          (value as { sessionKey?: string }).sessionKey === mainStream?.sessionKey,
      );
      expect(siblingRead).toMatchObject({
        type: "stream_read_state",
        sessionKey: mainStream?.sessionKey,
        lastReadMessageId: primaryEcho.id,
      });

      primaryQueue.dispose();
      secondaryQueue.dispose();
      primaryWs.terminate();
      secondaryWs.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("surfaces a reason when terminal attachments are filtered for clients without terminal_bubbles_v1", async () => {
    const noFeatureDeviceId = randomUUID();
    const withFeatureDeviceId = randomUUID();
    const baseEntry = {
      claimedName: "QA Sim",
      deviceInfo: {
        platform: "iOS",
        model: "iPhone",
      },
      userId: "feature_gate",
      isAdmin: false,
      tokenDelivered: true,
      createdAt: Date.now() - 10_000,
      lastSeenAt: Date.now() - 5_000,
    };
    const ctx = await setupTestServer([
      {
        ...baseEntry,
        deviceId: noFeatureDeviceId,
      },
      {
        ...baseEntry,
        deviceId: withFeatureDeviceId,
      },
    ]);
    try {
      const noFeaturePair = await performPairRequest(ctx.port, noFeatureDeviceId);
      const withFeaturePair = await performPairRequest(ctx.port, withFeatureDeviceId);
      const { ws: noFeatureWs } = await authenticateDevice(
        ctx.port,
        noFeatureDeviceId,
        noFeaturePair.token as string,
      );
      const { ws: withFeatureWs, auth: withFeatureAuth } = await authenticateDevice(
        ctx.port,
        withFeatureDeviceId,
        withFeaturePair.token as string,
        {
          authPayload: {
            clientFeatures: ["terminal_bubbles_v1"],
          },
        },
      );
      expect(withFeatureAuth.features).toEqual(
        expect.arrayContaining(["session_info", "terminal_bubbles_v1"]),
      );

      const descriptor = {
        version: 1,
        terminalSessionId: `ts_${randomUUID()}`,
        title: "gateway logs",
      };
      const base64 = Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64");
      const noFeatureEventPromise = waitForMessage(noFeatureWs);
      const withFeatureEventPromise = waitForMessage(withFeatureWs);
      await ctx.server.sendMessage({
        target: "feature_gate",
        text: "",
        attachments: [
          {
            data: base64,
            mimeType: "application/vnd.clawline.terminal-session+json",
          },
        ],
      });

      const noFeatureEvent = await noFeatureEventPromise;
      const withFeatureEvent = await withFeatureEventPromise;
      const withFeatureAttachments = Array.isArray(withFeatureEvent.attachments)
        ? withFeatureEvent.attachments
        : [];
      const noFeatureAttachments = Array.isArray(noFeatureEvent.attachments)
        ? noFeatureEvent.attachments
        : [];

      expect(
        withFeatureAttachments.some(
          (attachment: { type?: string; mimeType?: string } | undefined) =>
            attachment?.type === "document" &&
            attachment?.mimeType === "application/vnd.clawline.terminal-session+json",
        ),
      ).toBe(true);
      expect(
        noFeatureAttachments.some(
          (attachment: { type?: string; mimeType?: string } | undefined) =>
            attachment?.type === "document" &&
            attachment?.mimeType === "application/vnd.clawline.terminal-session+json",
        ),
      ).toBe(false);
      expect(noFeatureEvent.content).toContain("Terminal session hidden:");
      expect(withFeatureEvent.content).toBe("");

      noFeatureWs.terminate();
      withFeatureWs.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("handles alert endpoint by waking gateway", async () => {
    const entry = createAllowlistEntry();
    const ctx = await setupTestServer([entry]);
    const authHeader = await createAuthHeader(ctx, entry);
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ message: "Check on Flynn", source: "codex" }),
      });
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload).toEqual({ ok: true });
      expect(enqueueAnnounceMock).toHaveBeenCalledTimes(1);
      const call = enqueueAnnounceMock.mock.calls[0]?.[0] as {
        key?: string;
        item?: { prompt?: string; origin?: { channel?: string; to?: string } };
      };
      expect(call?.key).toBe("agent:main:main");
      expect(call?.item?.prompt).toBe(withMainAlertReplyRequirement("Check on Flynn"));
      expect(call?.item?.origin).toEqual({ channel: "clawline", to: "agent:main:main" });
    } finally {
      await ctx.cleanup();
    }
  });

  it("forwards alert attachments through the wake queue to the gateway", async () => {
    const entry = createAllowlistEntry();
    const ctx = await setupTestServer([entry]);
    const authHeader = await createAuthHeader(ctx, entry);
    const attachment = {
      type: "file",
      mimeType: "image/png",
      fileName: "surf-ace-alert.png",
      content: "Zm9v",
    };
    gatewayCallMock.mockResolvedValueOnce({
      runId: "ignored",
      status: "ok",
      result: { payloads: [] },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          attachments: [attachment],
          message: "Check the annotation",
          source: "surf-ace",
          sessionKey: "agent:main:clawline:flynn:main",
        }),
      });
      expect(response.status).toBe(200);
      const queued = enqueueAnnounceMock.mock.calls[0]?.[0] as
        | {
            item?: { attachments?: unknown[] };
            send?: (item: unknown) => Promise<void>;
          }
        | undefined;
      expect(queued?.item?.attachments).toEqual([attachment]);
      await queued?.send?.(queued.item);
      expect(gatewayCallMock).toHaveBeenCalledWith(
        expect.objectContaining({
          request: expect.objectContaining({
            attachments: [attachment],
            sessionKey: "agent:main:clawline:flynn:main",
          }),
        }),
      );
    } finally {
      await ctx.cleanup();
    }
  });

  it("logs correlated alert phases for replied main-session alerts", async () => {
    const entry = createAllowlistEntry();
    const info = vi.fn();
    const ctx = await setupTestServer([entry], {
      logger: {
        ...silentLogger,
        info,
      },
    });
    const authHeader = await createAuthHeader(ctx, entry);
    gatewayCallMock.mockResolvedValueOnce({
      runId: "ignored",
      status: "ok",
      result: {
        payloads: [{ type: "text", text: "Alert received" }],
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ message: "Check on Flynn", source: "codex" }),
      });
      expect(response.status).toBe(200);
      const queued = enqueueAnnounceMock.mock.calls[0]?.[0] as
        | {
            item?: { announceId?: string; sessionKey?: string };
            send?: (item: unknown) => Promise<void>;
          }
        | undefined;
      expect(typeof queued?.item?.announceId).toBe("string");
      await queued?.send?.(queued.item);

      const alertLogs = info.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.startsWith("[clawline] alert_run_phase "));
      expect(alertLogs).toEqual([
        expect.stringContaining(
          `phase=queued sessionKey=agent:main:main runId=${queued?.item?.announceId}`,
        ),
        expect.stringContaining(
          `phase=wake-dispatched sessionKey=agent:main:main runId=${queued?.item?.announceId}`,
        ),
        expect.stringContaining(
          `phase=agent-run-start sessionKey=agent:main:main runId=${queued?.item?.announceId}`,
        ),
        expect.stringContaining(
          `phase=agent-run-end sessionKey=agent:main:main runId=${queued?.item?.announceId} payloadCount=1 status=ok`,
        ),
        expect.stringContaining(
          `phase=replied sessionKey=agent:main:main runId=${queued?.item?.announceId} payloadCount=1`,
        ),
      ]);
    } finally {
      await ctx.cleanup();
    }
  });

  it("logs correlated alert phases for no-reply stream alerts", async () => {
    const entry = createAllowlistEntry();
    const info = vi.fn();
    const ctx = await setupTestServer([entry], {
      logger: {
        ...silentLogger,
        info,
      },
    });
    const authHeader = await createAuthHeader(ctx, entry);
    gatewayCallMock.mockResolvedValueOnce({
      runId: "ignored",
      status: "ok",
      result: {
        payloads: [],
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          message: "Check personal channel",
          source: "codex",
          sessionKey: "agent:main:clawline:flynn:main",
        }),
      });
      expect(response.status).toBe(200);
      const queued = enqueueAnnounceMock.mock.calls[0]?.[0] as
        | {
            item?: { announceId?: string; sessionKey?: string };
            send?: (item: unknown) => Promise<void>;
          }
        | undefined;
      expect(typeof queued?.item?.announceId).toBe("string");
      await queued?.send?.(queued.item);

      const alertLogs = info.mock.calls
        .map(([message]) => String(message))
        .filter((message) => message.startsWith("[clawline] alert_run_phase "));
      expect(alertLogs).toEqual([
        expect.stringContaining(
          `phase=queued sessionKey=agent:main:clawline:flynn:main runId=${queued?.item?.announceId}`,
        ),
        expect.stringContaining(
          `phase=wake-dispatched sessionKey=agent:main:clawline:flynn:main runId=${queued?.item?.announceId}`,
        ),
        expect.stringContaining(
          `phase=agent-run-start sessionKey=agent:main:clawline:flynn:main runId=${queued?.item?.announceId}`,
        ),
        expect.stringContaining(
          `phase=agent-run-end sessionKey=agent:main:clawline:flynn:main runId=${queued?.item?.announceId} payloadCount=0 status=ok`,
        ),
        expect.stringContaining(
          `phase=no-reply sessionKey=agent:main:clawline:flynn:main runId=${queued?.item?.announceId} payloadCount=0`,
        ),
      ]);
    } finally {
      await ctx.cleanup();
    }
  });

  it("returns 404 for unknown callback routes", async () => {
    const ctx = await setupTestServer([]);
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/callbacks/unknown/a1b2c3d4`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "text_selected", text: "oops" }),
      });
      expect(response.status).toBe(404);
    } finally {
      await ctx.cleanup();
    }
  });

  it("routes alerts to personal session keys with explicit channel/to", async () => {
    const entry = createAllowlistEntry();
    const ctx = await setupTestServer([entry]);
    const authHeader = await createAuthHeader(ctx, entry);
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          message: "Check personal channel",
          source: "codex",
          sessionKey: "agent:main:clawline:flynn:main",
        }),
      });
      expect(response.status).toBe(200);
      expect(enqueueAnnounceMock).toHaveBeenCalledTimes(1);
      const call = enqueueAnnounceMock.mock.calls[0]?.[0] as {
        key?: string;
        item?: { prompt?: string; origin?: { channel?: string; to?: string } };
      };
      expect(call?.key).toBe("agent:main:clawline:flynn:main");
      expect(call?.item?.prompt).toBe("Check personal channel");
      expect(call?.item?.origin).toEqual({
        channel: "clawline",
        to: "agent:main:clawline:flynn:main",
      });
    } finally {
      await ctx.cleanup();
    }
  });

  it("routes alerts to dynamic stream session keys without fallback", async () => {
    const entry = createAllowlistEntry();
    const ctx = await setupTestServer([entry]);
    const authHeader = await createAuthHeader(ctx, entry);
    const authToken = await createAuthToken(ctx, entry);
    const { ws } = await authenticateDevice(ctx.port, entry.deviceId, authToken);
    try {
      const createResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          displayName: "Ideas",
          idempotencyKey: `alert-stream-${randomUUID()}`,
        }),
      });
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as { stream?: { sessionKey?: string } };
      const streamSessionKey = created.stream?.sessionKey;
      expect(typeof streamSessionKey).toBe("string");

      const response = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          message: "Check dynamic stream",
          source: "codex",
          sessionKey: streamSessionKey,
        }),
      });
      expect(response.status).toBe(200);
      expect(enqueueAnnounceMock).toHaveBeenCalledTimes(1);
      const call = enqueueAnnounceMock.mock.calls[0]?.[0] as {
        key?: string;
        item?: { origin?: { channel?: string; to?: string } };
      };
      expect(call?.key).toBe(streamSessionKey);
      expect(call?.item?.origin).toEqual({
        channel: "clawline",
        to: streamSessionKey,
      });
    } finally {
      ws.terminate();
      await ctx.cleanup();
    }
  });

  it("routes alerts to globally registered non-clawline session keys", async () => {
    const entry = createAllowlistEntry();
    const ctx = await setupTestServer([entry], {
      sessionStorePathRelative: path.join("agents", "main", "sessions", "sessions.json"),
    });
    const authHeader = await createAuthHeader(ctx, entry);
    const globalSessionKey = "agent:codex:discord:channel:123";
    const rootDir = path.dirname(path.dirname(path.dirname(path.dirname(ctx.sessionStorePath))));
    const globalStorePath = path.join(rootDir, "agents", "codex", "sessions", "sessions.json");
    try {
      await fs.mkdir(path.dirname(globalStorePath), { recursive: true });
      await fs.writeFile(
        globalStorePath,
        JSON.stringify(
          {
            [globalSessionKey]: {
              sessionId: "sess_global_alert",
              updatedAt: Date.now(),
            },
          },
          null,
          2,
        ),
      );

      const response = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          message: "Check global registered session",
          source: "codex",
          sessionKey: globalSessionKey,
        }),
      });
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data).toEqual({ ok: true });
      expect(enqueueAnnounceMock).toHaveBeenCalledTimes(1);
      const call = enqueueAnnounceMock.mock.calls[0]?.[0] as {
        key?: string;
        item?: { origin?: { channel?: string; to?: string }; sessionKey?: string };
      };
      expect(call?.key).toBe(globalSessionKey);
      expect(call?.item?.sessionKey).toBe(globalSessionKey);
      expect(call?.item?.origin).toEqual({ channel: "clawline", to: globalSessionKey });
      expect(gatewayCallMock).not.toHaveBeenCalled();
      expect(sendMessageMock).not.toHaveBeenCalled();
      expect(loadSessionStoreMock).not.toHaveBeenCalled();

      const repeatedResponse = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          message: "Check cached global registered session",
          source: "codex",
          sessionKey: globalSessionKey,
        }),
      });
      expect(repeatedResponse.status).toBe(200);
      expect(loadSessionStoreMock).not.toHaveBeenCalled();

      const newGlobalSessionKey = "agent:codex:discord:channel:456";
      await fs.writeFile(
        globalStorePath,
        JSON.stringify(
          {
            [globalSessionKey]: {
              sessionId: "sess_global_alert",
              updatedAt: Date.now(),
            },
            [newGlobalSessionKey]: {
              sessionId: "sess_global_alert_new",
              updatedAt: Date.now(),
            },
          },
          null,
          2,
        ),
      );
      const invalidatedResponse = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          message: "Check invalidated global registered session",
          source: "codex",
          sessionKey: newGlobalSessionKey,
        }),
      });
      expect(invalidatedResponse.status).toBe(200);
      expect(loadSessionStoreMock).not.toHaveBeenCalled();
    } finally {
      await ctx.cleanup();
    }
  });

  it("routes alerts to main session keys without explicit channel/to", async () => {
    const entry = createAllowlistEntry();
    const ctx = await setupTestServer([entry]);
    const authHeader = await createAuthHeader(ctx, entry);
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          message: "Check main session",
          source: "codex",
          sessionKey: "agent:main:main",
        }),
      });
      expect(response.status).toBe(200);
      expect(enqueueAnnounceMock).toHaveBeenCalledTimes(1);
      const call = enqueueAnnounceMock.mock.calls[0]?.[0] as {
        key?: string;
        item?: { origin?: { channel?: string; to?: string } };
      };
      expect(call?.key).toBe("agent:main:main");
      expect(call?.item?.origin).toEqual({ channel: "clawline", to: "agent:main:main" });
    } finally {
      await ctx.cleanup();
    }
  });

  it("prepends exec completion prompt when system events are pending", async () => {
    const entry = createAllowlistEntry();
    const ctx = await setupTestServer([entry]);
    const authHeader = await createAuthHeader(ctx, entry);
    enqueueSystemEvent("Exec finished: voicemail", { sessionKey: "agent:main:main" });
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ message: "Check on Flynn", source: "codex" }),
      });
      expect(response.status).toBe(200);
      const call = enqueueAnnounceMock.mock.calls[0]?.[0] as
        | { item?: { prompt?: string } }
        | undefined;
      const expected = withMainAlertReplyRequirement(
        "These items completed. Execute the next task, or identify what is blocking.\n\nCheck on Flynn",
      );
      expect(call?.item?.prompt).toBe(expected);
    } finally {
      await ctx.cleanup();
    }
  });

  it("appends alert instructions text to alert payloads", async () => {
    const entry = createAllowlistEntry();
    const ctx = await setupTestServer([entry], {
      alertInstructionsText: "Follow up with Flynn ASAP.",
    });
    const authHeader = await createAuthHeader(ctx, entry);
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ message: "Check on Flynn", source: "codex" }),
      });
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload).toEqual({ ok: true });
      const expected = "Check on Flynn\n\nFollow up with Flynn ASAP.";
      const call = enqueueAnnounceMock.mock.calls[0]?.[0] as
        | { item?: { prompt?: string } }
        | undefined;
      expect(call?.item?.prompt).toBe(withMainAlertReplyRequirement(expected));
    } finally {
      await ctx.cleanup();
    }
  });

  it("does not append alert instructions text when noOverlay is true", async () => {
    const entry = createAllowlistEntry();
    const ctx = await setupTestServer([entry], {
      alertInstructionsText: "Follow up with Flynn ASAP.",
    });
    const authHeader = await createAuthHeader(ctx, entry);
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ message: "Check on Flynn", source: "codex", noOverlay: true }),
      });
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload).toEqual({ ok: true });
      const call = enqueueAnnounceMock.mock.calls[0]?.[0] as
        | { item?: { prompt?: string } }
        | undefined;
      expect(call?.item?.prompt).toBe(withMainAlertReplyRequirement("Check on Flynn"));
    } finally {
      await ctx.cleanup();
    }
  });

  it("initializes alert instructions file with default text when missing", async () => {
    const entry = createAllowlistEntry();
    const ctx = await setupTestServer([entry], { alertInstructionsText: null });
    const authHeader = await createAuthHeader(ctx, entry);
    try {
      const fileContents = (await fs.readFile(ctx.alertInstructionsPath, "utf8")).trim();
      expect(fileContents).toBe(DEFAULT_ALERT_INSTRUCTIONS_TEXT);
      const response = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ message: "Check on Flynn", source: "codex" }),
      });
      expect(response.status).toBe(200);
      const expected = `Check on Flynn\n\n${DEFAULT_ALERT_INSTRUCTIONS_TEXT}`;
      const call = enqueueAnnounceMock.mock.calls[0]?.[0] as
        | { item?: { prompt?: string } }
        | undefined;
      expect(call?.item?.prompt).toBe(withMainAlertReplyRequirement(expected));
    } finally {
      await ctx.cleanup();
    }
  });

  it("returns 400 when alert payload is missing message", async () => {
    const entry = createAllowlistEntry();
    const ctx = await setupTestServer([entry]);
    const authHeader = await createAuthHeader(ctx, entry);
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({ source: "codex" }),
      });
      expect(response.status).toBe(400);
      const data = (await response.json()) as { code?: string };
      expect(data.code).toBe("invalid_message");
      expect(enqueueAnnounceMock).not.toHaveBeenCalled();
      expect(gatewayCallMock).not.toHaveBeenCalled();
      expect(sendMessageMock).not.toHaveBeenCalled();
    } finally {
      await ctx.cleanup();
    }
  });

  it("returns 400 for malformed alert session keys", async () => {
    const entry = createAllowlistEntry();
    const ctx = await setupTestServer([entry]);
    const authHeader = await createAuthHeader(ctx, entry);
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          message: "Bad key",
          source: "codex",
          sessionKey: "not-a-session-key",
        }),
      });
      expect(response.status).toBe(400);
      const data = (await response.json()) as { code?: string };
      expect(data.code).toBe("invalid_session_key");
      expect(enqueueAnnounceMock).not.toHaveBeenCalled();
      expect(gatewayCallMock).not.toHaveBeenCalled();
      expect(sendMessageMock).not.toHaveBeenCalled();
    } finally {
      await ctx.cleanup();
    }
  });

  it("returns 404 for missing alert session keys", async () => {
    const entry = createAllowlistEntry();
    const ctx = await setupTestServer([entry]);
    const authHeader = await createAuthHeader(ctx, entry);
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/alert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        body: JSON.stringify({
          message: "Missing session",
          source: "codex",
          sessionKey: "agent:main:clawline:flynn:s_deadbeef",
        }),
      });
      expect(response.status).toBe(404);
      const data = (await response.json()) as { code?: string };
      expect(data.code).toBe("stream_not_found");
      expect(enqueueAnnounceMock).not.toHaveBeenCalled();
      expect(gatewayCallMock).not.toHaveBeenCalled();
      expect(sendMessageMock).not.toHaveBeenCalled();
    } finally {
      await ctx.cleanup();
    }
  });

  it("sends stream_snapshot after auth_result and before replay", async () => {
    const deviceId = randomUUID();
    const entry = createAllowlistEntry({
      deviceId,
      userId: "flynn",
      isAdmin: false,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const pair = await performPairRequest(ctx.port, deviceId);
      const { ws, auth, streamSnapshot } = await authenticateDevice(
        ctx.port,
        deviceId,
        pair.token as string,
      );
      expect(auth.type).toBe("auth_result");
      expect(streamSnapshot.type).toBe("stream_snapshot");
      expect(Array.isArray(streamSnapshot.streams)).toBe(true);
      expect(streamSnapshot.streams).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionKey: "agent:main:clawline:flynn:main",
            kind: "main",
            displayName: "Personal",
          }),
        ]),
      );
      ws.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("persists stream read state and syncs it across devices", async () => {
    const userId = "flynn";
    const sessionKey = "agent:main:clawline:flynn:main";
    const firstDeviceId = randomUUID();
    const secondDeviceId = randomUUID();
    const thirdDeviceId = randomUUID();
    const now = Date.now();
    const baseEntry = {
      claimedName: "Flynn",
      deviceInfo: { platform: "iOS", model: "iPhone" },
      userId,
      isAdmin: false,
      tokenDelivered: true,
      createdAt: now - 5_000,
      lastSeenAt: now - 2_000,
    };
    const ctx = await setupTestServer([
      { ...baseEntry, deviceId: firstDeviceId },
      { ...baseEntry, deviceId: secondDeviceId },
      { ...baseEntry, deviceId: thirdDeviceId },
    ]);
    try {
      const firstPair = await performPairRequest(ctx.port, firstDeviceId);
      const secondPair = await performPairRequest(ctx.port, secondDeviceId);
      const thirdPair = await performPairRequest(ctx.port, thirdDeviceId);
      const { ws: firstWs } = await authenticateDevice(
        ctx.port,
        firstDeviceId,
        firstPair.token as string,
      );
      const { ws: secondWs } = await authenticateDevice(
        ctx.port,
        secondDeviceId,
        secondPair.token as string,
      );
      const firstQueue = createMessageQueue(firstWs);
      const secondQueue = createMessageQueue(secondWs);

      const sent = await ctx.server.sendMessage({
        target: userId,
        text: "hello",
        sessionKey,
      });

      expect(await firstQueue.next()).toMatchObject({
        type: "message",
        id: sent.messageId,
        sessionKey,
      });
      expect(await secondQueue.next()).toMatchObject({
        type: "message",
        id: sent.messageId,
        sessionKey,
      });

      firstWs.send(
        JSON.stringify({
          type: "stream_read",
          sessionKey,
          lastReadMessageId: sent.messageId,
        }),
      );

      expect(
        await waitForQueuedMessageWithTimeout(
          firstQueue,
          (value) =>
            typeof value === "object" &&
            value !== null &&
            (value as { type?: string; sessionKey?: string; lastReadMessageId?: string }).type ===
              "stream_read_state" &&
            (value as { sessionKey?: string }).sessionKey === sessionKey &&
            (value as { lastReadMessageId?: string }).lastReadMessageId === sent.messageId,
        ),
      ).toMatchObject({
        type: "stream_read_state",
        sessionKey,
        lastReadMessageId: sent.messageId,
      });
      expect(
        await waitForQueuedMessageWithTimeout(
          secondQueue,
          (value) =>
            typeof value === "object" &&
            value !== null &&
            (value as { type?: string; sessionKey?: string; lastReadMessageId?: string }).type ===
              "stream_read_state" &&
            (value as { sessionKey?: string }).sessionKey === sessionKey &&
            (value as { lastReadMessageId?: string }).lastReadMessageId === sent.messageId,
        ),
      ).toMatchObject({
        type: "stream_read_state",
        sessionKey,
        lastReadMessageId: sent.messageId,
      });

      const { auth: thirdAuth, ws: thirdWs } = await authenticateDevice(
        ctx.port,
        thirdDeviceId,
        thirdPair.token as string,
      );
      expect(thirdAuth.streamReadStates).toMatchObject({ [sessionKey]: sent.messageId });

      firstQueue.dispose();
      secondQueue.dispose();
      firstWs.terminate();
      secondWs.terminate();
      thirdWs.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("supports stream CRUD over REST and broadcasts stream events to all user sockets", async () => {
    const userId = "flynn";
    const firstDeviceId = randomUUID();
    const secondDeviceId = randomUUID();
    const now = Date.now();
    const baseEntry = {
      claimedName: "Flynn",
      deviceInfo: { platform: "iOS", model: "iPhone" },
      userId,
      isAdmin: false,
      tokenDelivered: true,
      createdAt: now - 5_000,
      lastSeenAt: now - 2_000,
    };
    const ctx = await setupTestServer([
      { ...baseEntry, deviceId: firstDeviceId },
      { ...baseEntry, deviceId: secondDeviceId },
    ]);
    try {
      const firstPair = await performPairRequest(ctx.port, firstDeviceId);
      const secondPair = await performPairRequest(ctx.port, secondDeviceId);
      const firstToken = firstPair.token as string;
      const secondToken = secondPair.token as string;
      const { ws: firstWs } = await authenticateDevice(ctx.port, firstDeviceId, firstToken);
      const { ws: secondWs } = await authenticateDevice(ctx.port, secondDeviceId, secondToken);
      const firstQueue = createMessageQueue(firstWs);
      const secondQueue = createMessageQueue(secondWs);

      const listResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        headers: { Authorization: `Bearer ${firstToken}` },
      });
      expect(listResponse.status).toBe(200);
      const listPayload = (await listResponse.json()) as {
        streams: Array<{
          sessionKey: string;
          orderIndex: number;
          displayName: string;
          kind: string;
        }>;
      };
      expect(listPayload.streams).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionKey: "agent:main:clawline:flynn:main",
            kind: "main",
            displayName: "Personal",
          }),
        ]),
      );

      const createResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${firstToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idempotencyKey: "req_create_stream_1",
          displayName: "Research",
        }),
      });
      expect(createResponse.status).toBe(201);
      const createdPayload = (await createResponse.json()) as {
        stream: { sessionKey: string; kind: string };
      };
      expect(createdPayload.stream.kind).toBe("custom");
      expect(createdPayload.stream.sessionKey).toMatch(/:s_[0-9a-f]{8}$/);
      expect(await firstQueue.next()).toMatchObject({
        type: "stream_created",
        stream: { sessionKey: createdPayload.stream.sessionKey },
      });
      expect(await secondQueue.next()).toMatchObject({
        type: "stream_created",
        stream: { sessionKey: createdPayload.stream.sessionKey },
      });

      const encodedKey = encodeURIComponent(createdPayload.stream.sessionKey);
      const renameResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams/${encodedKey}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${firstToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ displayName: "Research v2" }),
      });
      expect(renameResponse.status).toBe(200);
      expect(await firstQueue.next()).toMatchObject({
        type: "stream_updated",
        stream: { sessionKey: createdPayload.stream.sessionKey, displayName: "Research v2" },
      });
      expect(await secondQueue.next()).toMatchObject({
        type: "stream_updated",
        stream: { sessionKey: createdPayload.stream.sessionKey, displayName: "Research v2" },
      });

      const deleteResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams/${encodedKey}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${firstToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ idempotencyKey: "req_delete_stream_1" }),
      });
      expect(deleteResponse.status).toBe(200);
      expect(await firstQueue.next()).toMatchObject({
        type: "stream_deleted",
        sessionKey: createdPayload.stream.sessionKey,
      });
      expect(await secondQueue.next()).toMatchObject({
        type: "stream_deleted",
        sessionKey: createdPayload.stream.sessionKey,
      });

      const listAfterDelete = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        headers: { Authorization: `Bearer ${firstToken}` },
      });
      const listAfterDeletePayload = (await listAfterDelete.json()) as {
        streams: Array<{ sessionKey: string }>;
      };
      expect(
        listAfterDeletePayload.streams.some(
          (stream) => stream.sessionKey === createdPayload.stream.sessionKey,
        ),
      ).toBe(false);

      firstQueue.dispose();
      secondQueue.dispose();
      firstWs.terminate();
      secondWs.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("lists any non-clawline, non-provisioned session-store entry across agent stores", async () => {
    const userId = "flynn";
    const deviceId = randomUUID();
    const now = Date.now();
    const excludedSessionKey = "agent:main:openclaw:flynn:s_local_adopted";
    const provisionedSessionKey = "agent:main:openclaw:flynn:s_provisioned";
    const ctx = await setupTestServer(
      [
        {
          claimedName: "Flynn",
          deviceInfo: { platform: "iOS", model: "iPhone" },
          userId,
          isAdmin: true,
          tokenDelivered: true,
          createdAt: now - 5_000,
          lastSeenAt: now - 2_000,
          deviceId,
        },
      ],
      { sessionStorePathRelative: path.join("agents", "main", "sessions", "sessions.json") },
    );
    try {
      await fs.writeFile(
        ctx.sessionStorePath,
        JSON.stringify(
          {
            "agent:main:clawline:flynn:main": {
              sessionId: "sess_stream",
              updatedAt: now - 300,
              displayName: "Personal",
              channel: "clawline",
            },
            "agent:main:openclaw:flynn:s_trackme": {
              sessionId: "sess_trackable",
              updatedAt: now - 100,
              displayName: "Research Session",
              channel: "openclaw",
              lastChannel: "openclaw",
              lastTo: "flynn",
            },
            "agent:main:discord:channel:123": {
              sessionId: "sess_discord_channel",
              updatedAt: now - 90,
              displayName: "Discord Channel",
              channel: "discord",
              lastChannel: "discord",
            },
            "agent:main:cron:nightly-digest:run:run-1": {
              sessionId: "sess_cron_run_1",
              updatedAt: now - 85,
              label: "Cron: Nightly digest",
              channel: "openclaw",
            },
            "agent:main:cron:nightly-digest:run:run-2": {
              sessionId: "sess_cron_run_2",
              updatedAt: now - 70,
              label: "Cron: Nightly digest",
              channel: "openclaw",
              lastChannel: "openclaw",
              lastTo: "cron",
            },
            "agent:main:subagent:uuid": {
              sessionId: "sess_subagent",
              updatedAt: now - 110,
              label: "Subagent Session",
              channel: "openclaw",
            },
            "agent:main:main": {
              sessionId: "sess_main",
              updatedAt: now - 120,
              displayName: "Main Session",
              channel: "openclaw",
            },
            "agent:main:openclaw:flynn:s_label_only": {
              sessionId: "sess_label_only",
              updatedAt: now - 200,
              label: "Label Session",
              channel: "openclaw",
            },
            [excludedSessionKey]: {
              sessionId: "sess_excluded",
              updatedAt: now - 50,
              displayName: "Already Adopted",
              channel: "openclaw",
            },
            [provisionedSessionKey]: {
              sessionId: "sess_provisioned",
              updatedAt: now - 75,
              displayName: "Provisioned Session",
              channel: "openclaw",
            },
            "agent:main:clawline:flynn:s_hidden": {
              sessionId: "sess_native_clawline",
              updatedAt: now - 25,
              displayName: "Native Clawline Session",
              channel: "clawline",
            },
            "agent:main:openclaw:other:s_hidden": {
              sessionId: "sess_other",
              updatedAt: now - 50,
              displayName: "Other Session",
              channel: "openclaw",
            },
          },
          null,
          2,
        ),
      );
      const heimdalSessionStorePath = path.join(
        path.dirname(path.dirname(path.dirname(ctx.sessionStorePath))),
        "heimdal",
        "sessions",
        "sessions.json",
      );
      await fs.mkdir(path.dirname(heimdalSessionStorePath), { recursive: true });
      await fs.writeFile(
        heimdalSessionStorePath,
        JSON.stringify(
          {
            "agent:heimdal:main": {
              sessionId: "sess_heimdal_main",
              updatedAt: now - 60,
              displayName: "Heimdal Main",
              channel: "openclaw",
              lastChannel: "openclaw",
              lastTo: "agent:heimdal:main",
            },
          },
          null,
          2,
        ),
      );

      const pairResult = await performPairRequest(ctx.port, deviceId);
      const token = pairResult.token as string;
      const { ws } = await authenticateDevice(ctx.port, deviceId, token);
      const dbPath = path.join(path.dirname(ctx.allowlistPath), "clawline.sqlite");
      const db = new BetterSqlite3(dbPath);
      try {
        db.prepare(
          `INSERT INTO stream_sessions
             (userId, sessionKey, displayName, kind, orderIndex, isBuiltIn, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          userId,
          provisionedSessionKey,
          "Provisioned Session",
          "custom",
          7,
          0,
          now - 75,
          now - 75,
        );
      } finally {
        db.close();
      }

      const response = await fetch(
        `http://127.0.0.1:${ctx.port}/api/trackable-sessions?excludeSessionKey=${encodeURIComponent(
          excludedSessionKey,
        )}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        sessions: Array<{
          sessionKey: string;
          displayName: string;
          updatedAt: number;
          channel?: string;
          lastChannel?: string;
          lastTo?: string;
        }>;
      };
      expect(payload.sessions).toEqual([
        {
          sessionKey: "agent:main:openclaw:other:s_hidden",
          displayName: "Other Session",
          updatedAt: now - 50,
          channel: "openclaw",
          lastChannel: "openclaw",
        },
        {
          sessionKey: "agent:heimdal:main",
          displayName: "Heimdal Main",
          updatedAt: now - 60,
          channel: "openclaw",
          lastChannel: "openclaw",
          lastTo: "agent:heimdal:main",
        },
        {
          sessionKey: "agent:main:cron:nightly-digest:run:run-2",
          displayName: "Cron: Nightly digest (run-2)",
          updatedAt: now - 70,
          channel: "openclaw",
          lastChannel: "openclaw",
          lastTo: "cron",
        },
        {
          sessionKey: "agent:main:cron:nightly-digest:run:run-1",
          displayName: "Cron: Nightly digest (run-1)",
          updatedAt: now - 85,
          channel: "openclaw",
          lastChannel: "openclaw",
        },
        {
          sessionKey: "agent:main:discord:channel:123",
          displayName: "Discord Channel",
          updatedAt: now - 90,
          channel: "discord",
          lastChannel: "discord",
        },
        {
          sessionKey: "agent:main:openclaw:flynn:s_trackme",
          displayName: "Research Session",
          updatedAt: now - 100,
          channel: "openclaw",
          lastChannel: "openclaw",
          lastTo: "flynn",
        },
        {
          sessionKey: "agent:main:subagent:uuid",
          displayName: "Subagent Session",
          updatedAt: now - 110,
          channel: "openclaw",
          lastChannel: "openclaw",
        },
        {
          sessionKey: "agent:main:openclaw:flynn:s_label_only",
          displayName: "Label Session",
          updatedAt: now - 200,
          channel: "openclaw",
          lastChannel: "openclaw",
        },
      ]);

      ws.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("adopts and routes cross-agent sessions from merged session stores", async () => {
    const deviceId = randomUUID();
    const adoptedSessionKey = "agent:heimdal:main";
    let capturedCtx: Record<string, unknown> | null = null;
    const replyResolver: typeof testReplyResolver = async (ctx) => {
      capturedCtx = ctx as unknown as Record<string, unknown>;
      return { text: "heimdal adopted ok" };
    };
    const entry = createAllowlistEntry({
      deviceId,
      userId: "flynn",
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry], {
      replyResolver,
      sessionStorePathRelative: path.join("agents", "main", "sessions", "sessions.json"),
    });
    try {
      const heimdalSessionStorePath = path.join(
        path.dirname(path.dirname(path.dirname(ctx.sessionStorePath))),
        "heimdal",
        "sessions",
        "sessions.json",
      );
      await fs.mkdir(path.dirname(heimdalSessionStorePath), { recursive: true });
      await fs.writeFile(
        heimdalSessionStorePath,
        JSON.stringify(
          {
            [adoptedSessionKey]: {
              sessionId: "sess_heimdal_main",
              updatedAt: Date.now() - 100,
              displayName: "Heimdal Main",
              channel: "openclaw",
              lastChannel: "openclaw",
              lastTo: adoptedSessionKey,
            },
          },
          null,
          2,
        ),
      );

      const pair = await performPairRequest(ctx.port, deviceId);
      const token = pair.token as string;
      const authed = await authenticateDevice(ctx.port, deviceId, token);
      const queue = createMessageQueue(authed.ws);

      const adoptResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams/adopt`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionKey: adoptedSessionKey }),
      });
      expect(adoptResponse.status).toBe(200);
      const adoptPayload = (await adoptResponse.json()) as {
        stream: { sessionKey: string; displayName: string; adopted: boolean };
      };
      expect(adoptPayload.stream).toMatchObject({
        sessionKey: adoptedSessionKey,
        displayName: "Heimdal Main",
        adopted: true,
      });

      const messageId = `c_${randomUUID()}`;
      authed.ws.send(
        JSON.stringify({
          type: "message",
          id: messageId,
          sessionKey: adoptedSessionKey,
          content: "hello heimdal adopted",
        }),
      );

      const ack = await waitForQueuedMessage(queue, (value) => {
        const typed = value as { type?: string; id?: string };
        return typed?.type === "ack" && typed.id === messageId;
      });
      expect(ack).toMatchObject({ type: "ack", id: messageId });

      const assistantMessage = (await waitForQueuedMessage(queue, (value) => {
        const typed = value as { type?: string; role?: string; sessionKey?: string };
        return (
          typed?.type === "message" &&
          typed.role === "assistant" &&
          typed.sessionKey === adoptedSessionKey
        );
      })) as { id: string; sessionKey?: string; content?: string };
      expect(assistantMessage).toMatchObject({
        sessionKey: adoptedSessionKey,
        content: "heimdal adopted ok",
      });

      authed.ws.send(
        JSON.stringify({
          type: "stream_read",
          sessionKey: adoptedSessionKey,
          lastReadMessageId: assistantMessage.id,
        }),
      );
      const readState = await waitForQueuedMessage(queue, (value) => {
        const typed = value as { type?: string; sessionKey?: string; lastReadMessageId?: string };
        return (
          typed?.type === "stream_read_state" &&
          typed.sessionKey === adoptedSessionKey &&
          typed.lastReadMessageId === assistantMessage.id
        );
      });
      expect(readState).toMatchObject({
        type: "stream_read_state",
        sessionKey: adoptedSessionKey,
        lastReadMessageId: assistantMessage.id,
      });

      expect(capturedCtx).toMatchObject({
        SessionKey: adoptedSessionKey,
        Provider: "openclaw",
        Surface: "openclaw",
        OriginatingChannel: "openclaw",
        OriginatingTo: adoptedSessionKey,
      });

      queue.dispose();
      authed.ws.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("serializes same-stream agent dispatch end to end", async () => {
    const deviceId = randomUUID();
    const firstMessageId = `c_${randomUUID()}`;
    const secondMessageId = `c_${randomUUID()}`;
    let secondStarted = false;
    let resolveFirstEntered!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstEntered = resolve;
    });
    let releaseBlockedFirst!: () => void;
    const blockedFirst = new Promise<void>((resolve) => {
      releaseBlockedFirst = resolve;
    });
    const replyResolver: typeof testReplyResolver = async (ctx) => {
      const messageSid = (ctx as { MessageSid?: unknown }).MessageSid;
      if (messageSid === firstMessageId) {
        resolveFirstEntered();
        await blockedFirst;
        return { text: "first reply" };
      }
      if (messageSid === secondMessageId) {
        secondStarted = true;
        return { text: "second reply" };
      }
      return { text: "unexpected reply" };
    };
    const entry = createAllowlistEntry({
      deviceId,
      userId: "flynn",
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry], { replyResolver });
    try {
      const pair = await performPairRequest(ctx.port, deviceId);
      const token = pair.token as string;
      const { ws } = await authenticateDevice(ctx.port, deviceId, token);
      const queue = createMessageQueue(ws);

      ws.send(
        JSON.stringify({
          type: "message",
          id: firstMessageId,
          content: "first prompt",
        }),
      );
      await waitForQueuedMessage(queue, (value) => {
        const typed = value as { type?: string; id?: string };
        return typed.type === "ack" && typed.id === firstMessageId;
      });
      const firstEcho = (await waitForQueuedMessageWithTimeout(queue, (value) => {
        const typed = value as {
          type?: string;
          role?: string;
          content?: string;
          clientMessageId?: string;
          sessionKey?: string;
        };
        return (
          typed.type === "message" && typed.role === "user" && typed.content === "first prompt"
        );
      })) as { id?: string; clientMessageId?: string; sessionKey?: string };
      expect(firstEcho.id?.startsWith("s_")).toBe(true);
      expect(firstEcho.clientMessageId).toBe(firstMessageId);
      expect(firstEcho.sessionKey).toBe("agent:main:clawline:flynn:main");
      await firstStarted;

      ws.send(
        JSON.stringify({
          type: "message",
          id: secondMessageId,
          content: "second prompt",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(secondStarted).toBe(false);

      releaseBlockedFirst();

      const firstAssistant = (await waitForQueuedMessageWithTimeout(queue, (value) => {
        const typed = value as {
          type?: string;
          role?: string;
          content?: string;
          replyToMessageId?: string;
        };
        return typed.type === "message" && typed.role === "assistant";
      })) as { content?: string; replyToMessageId?: string; replyToClientMessageId?: string };
      expect(firstAssistant.content).toBe("first reply");
      expect(firstAssistant.replyToMessageId).toBe(firstEcho.id);
      expect(firstAssistant.replyToClientMessageId).toBe(firstMessageId);

      const secondAssistant = (await waitForQueuedMessageWithTimeout(queue, (value) => {
        const typed = value as { type?: string; role?: string; content?: string };
        return typed.type === "message" && typed.role === "assistant";
      })) as { content?: string };
      expect(secondAssistant.content).toBe("second reply");

      queue.dispose();
      ws.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("rejects trackable session listing for non-admin users", async () => {
    const deviceId = randomUUID();
    const entry = createAllowlistEntry({
      deviceId,
      userId: "flynn",
      isAdmin: false,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const pair = await performPairRequest(ctx.port, deviceId);
      const token = pair.token as string;
      const { ws } = await authenticateDevice(ctx.port, deviceId, token);
      const response = await fetch(`http://127.0.0.1:${ctx.port}/api/trackable-sessions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "forbidden", message: "Admin access required" },
      });
      ws.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("merges auth-time adopted session keys for inbound sends without broadening session_info", async () => {
    const deviceId = randomUUID();
    const adoptedSessionKey = "agent:main:main";
    let capturedCtx: Record<string, unknown> | null = null;
    const replyResolver: typeof testReplyResolver = async (ctx) => {
      capturedCtx = ctx as unknown as Record<string, unknown>;
      return { text: "adopted ok" };
    };
    const entry = createAllowlistEntry({
      deviceId,
      userId: "flynn",
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry], { replyResolver });
    try {
      await fs.writeFile(
        ctx.sessionStorePath,
        JSON.stringify(
          {
            [adoptedSessionKey]: {
              sessionId: "sess_adopted_main",
              updatedAt: Date.now() - 100,
              displayName: "Main Session",
              channel: "openclaw",
              lastChannel: "openclaw",
              lastTo: "agent:main:main",
            },
          },
          null,
          2,
        ),
      );

      const pair = await performPairRequest(ctx.port, deviceId);
      const token = pair.token as string;
      const { ws, auth, sessionInfo } = await authenticateDevice(ctx.port, deviceId, token, {
        authPayload: {
          adoptedSessionKeys: [adoptedSessionKey],
        },
      });
      expect(auth.sessionKeys).toEqual(["agent:main:clawline:flynn:main", "agent:main:main"]);
      expect((sessionInfo as { sessionKeys?: string[] } | null)?.sessionKeys).toEqual([
        "agent:main:clawline:flynn:main",
        "agent:main:main",
      ]);

      const queue = createMessageQueue(ws);
      const messageId = `c_${randomUUID()}`;
      ws.send(
        JSON.stringify({
          type: "message",
          id: messageId,
          sessionKey: adoptedSessionKey,
          content: "hello adopted",
        }),
      );

      const ack = await waitForQueuedMessage(queue, (value) => {
        const typed = value as { type?: string; id?: string };
        return typed?.type === "ack" && typed.id === messageId;
      });
      expect(ack).toMatchObject({ type: "ack", id: messageId });

      const echoedUserMessage = (await waitForQueuedMessage(queue, (value) => {
        const typed = value as { type?: string; role?: string; sessionKey?: string };
        return (
          typed?.type === "message" &&
          typed.role === "user" &&
          typed.sessionKey === adoptedSessionKey
        );
      })) as { sessionKey?: string };
      expect(echoedUserMessage.sessionKey).toBe(adoptedSessionKey);

      const assistantMessage = (await waitForQueuedMessage(queue, (value) => {
        const typed = value as { type?: string; role?: string; sessionKey?: string };
        return (
          typed?.type === "message" &&
          typed.role === "assistant" &&
          typed.sessionKey === adoptedSessionKey
        );
      })) as { sessionKey?: string; content?: string };
      expect(assistantMessage).toMatchObject({
        sessionKey: adoptedSessionKey,
        content: "adopted ok",
      });

      expect(capturedCtx).toMatchObject({
        SessionKey: adoptedSessionKey,
        Provider: "openclaw",
        Surface: "openclaw",
        OriginatingChannel: "openclaw",
        OriginatingTo: "agent:main:main",
      });

      const dbPath = path.join(path.dirname(ctx.allowlistPath), "clawline.sqlite");
      const db = new BetterSqlite3(dbPath, { readonly: true });
      try {
        const rows = db
          .prepare(`SELECT sessionKey FROM events WHERE userId = ? ORDER BY sequence ASC`)
          .all("flynn") as Array<{ sessionKey: string | null }>;
        expect(rows.at(-1)?.sessionKey).toBe(adoptedSessionKey);
        expect(rows.some((row) => row.sessionKey === adoptedSessionKey)).toBe(true);
      } finally {
        db.close();
      }

      queue.dispose();
      ws.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("ignores auth-time adopted session keys for non-admin users", async () => {
    const deviceId = randomUUID();
    const adoptedSessionKey = "agent:main:main";
    const entry = createAllowlistEntry({
      deviceId,
      userId: "flynn",
      isAdmin: false,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      await fs.writeFile(
        ctx.sessionStorePath,
        JSON.stringify(
          {
            [adoptedSessionKey]: {
              sessionId: "sess_adopted_main",
              updatedAt: Date.now() - 100,
              displayName: "Main Session",
              channel: "openclaw",
              lastChannel: "openclaw",
              lastTo: adoptedSessionKey,
            },
          },
          null,
          2,
        ),
      );

      const pair = await performPairRequest(ctx.port, deviceId);
      const token = pair.token as string;
      const { ws, auth, sessionInfo } = await authenticateDevice(ctx.port, deviceId, token, {
        authPayload: {
          adoptedSessionKeys: [adoptedSessionKey],
        },
      });
      expect(auth.sessionKeys).toEqual(["agent:main:clawline:flynn:main"]);
      expect((sessionInfo as { sessionKeys?: string[] } | null)?.sessionKeys).toEqual([
        "agent:main:clawline:flynn:main",
      ]);

      const queue = createMessageQueue(ws);
      ws.send(
        JSON.stringify({
          type: "message",
          id: `c_${randomUUID()}`,
          sessionKey: adoptedSessionKey,
          content: "should stay blocked",
        }),
      );
      const error = await waitForQueuedMessage(queue, (value) => {
        const typed = value as { type?: string; code?: string };
        return typed?.type === "error" && typed.code === "stream_not_found";
      });
      expect(error).toMatchObject({
        type: "error",
        code: "stream_not_found",
      });

      queue.dispose();
      ws.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("records adopted sessions via REST and rebuilds them on reconnect", async () => {
    const deviceId = randomUUID();
    const adoptedSessionKey = "agent:main:subagent:uuid";
    const entry = createAllowlistEntry({
      deviceId,
      userId: "flynn",
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      await fs.writeFile(
        ctx.sessionStorePath,
        JSON.stringify(
          {
            [adoptedSessionKey]: {
              sessionId: "sess_subagent",
              updatedAt: Date.now() - 100,
              label: "Subagent Session",
              channel: "openclaw",
              lastChannel: "openclaw",
              lastTo: adoptedSessionKey,
            },
          },
          null,
          2,
        ),
      );

      const pair = await performPairRequest(ctx.port, deviceId);
      const token = pair.token as string;
      const authed = await authenticateDevice(ctx.port, deviceId, token);
      const queue = createMessageQueue(authed.ws);

      const beforeAdoptMessageId = `c_${randomUUID()}`;
      authed.ws.send(
        JSON.stringify({
          type: "message",
          id: beforeAdoptMessageId,
          sessionKey: adoptedSessionKey,
          content: "blocked before adopt",
        }),
      );
      const beforeAdoptError = await waitForQueuedMessage(queue, (value) => {
        const typed = value as { type?: string; code?: string };
        return typed?.type === "error" && typed.code === "stream_not_found";
      });
      expect(beforeAdoptError).toMatchObject({
        type: "error",
        code: "stream_not_found",
      });

      const adoptResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams/adopt`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionKey: adoptedSessionKey }),
      });
      expect(adoptResponse.status).toBe(200);
      const adoptPayload = (await adoptResponse.json()) as {
        stream: { sessionKey: string; displayName: string; adopted: boolean; createdAt: number };
      };
      expect(adoptPayload.stream.sessionKey).toBe(adoptedSessionKey);
      expect(adoptPayload.stream.displayName).toBe("Subagent Session");
      expect(adoptPayload.stream.adopted).toBe(true);
      expect(adoptPayload.stream.createdAt).toEqual(expect.any(Number));

      const streamsResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(streamsResponse.status).toBe(200);
      const streamsPayload = (await streamsResponse.json()) as {
        streams: Array<{ sessionKey: string; adopted: boolean }>;
      };
      expect(streamsPayload.streams).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionKey: adoptedSessionKey,
            adopted: true,
          }),
        ]),
      );

      const afterAdoptMessageId = `c_${randomUUID()}`;
      authed.ws.send(
        JSON.stringify({
          type: "message",
          id: afterAdoptMessageId,
          sessionKey: adoptedSessionKey,
          content: "allowed after adopt",
        }),
      );
      const afterAdoptAck = await waitForQueuedMessage(queue, (value) => {
        const typed = value as { type?: string; id?: string };
        return typed?.type === "ack" && typed.id === afterAdoptMessageId;
      });
      expect(afterAdoptAck).toMatchObject({ type: "ack", id: afterAdoptMessageId });

      queue.dispose();
      authed.ws.terminate();

      const reauthed = await authenticateDevice(ctx.port, deviceId, token);
      const replayQueue = createMessageQueue(reauthed.ws);
      const afterReconnectMessageId = `c_${randomUUID()}`;
      reauthed.ws.send(
        JSON.stringify({
          type: "message",
          id: afterReconnectMessageId,
          sessionKey: adoptedSessionKey,
          content: "still allowed after reconnect",
        }),
      );
      const afterReconnectAck = await waitForQueuedMessage(replayQueue, (value) => {
        const typed = value as { type?: string; id?: string };
        return typed?.type === "ack" && typed.id === afterReconnectMessageId;
      });
      expect(afterReconnectAck).toMatchObject({ type: "ack", id: afterReconnectMessageId });

      const dbPath = path.join(path.dirname(ctx.allowlistPath), "clawline.sqlite");
      const db = new BetterSqlite3(dbPath, { readonly: true });
      try {
        const adoptedRows = db
          .prepare(`SELECT userId, sessionKey FROM adopted_sessions WHERE userId = ?`)
          .all("flynn") as Array<{ userId: string; sessionKey: string }>;
        expect(adoptedRows).toEqual([{ userId: "flynn", sessionKey: adoptedSessionKey }]);
        const streamRows = db
          .prepare(
            `SELECT userId, sessionKey, displayName, kind, isBuiltIn, adopted
             FROM stream_sessions
             WHERE userId = ? AND sessionKey = ?`,
          )
          .all("flynn", adoptedSessionKey) as Array<{
          userId: string;
          sessionKey: string;
          displayName: string;
          kind: string;
          isBuiltIn: number;
          adopted: number;
        }>;
        expect(streamRows).toEqual([
          {
            userId: "flynn",
            sessionKey: adoptedSessionKey,
            displayName: "Subagent Session",
            kind: "custom",
            isBuiltIn: 0,
            adopted: 1,
          },
        ]);
      } finally {
        db.close();
      }

      replayQueue.dispose();
      reauthed.ws.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("delivers outbound sends to adopted non-clawline session keys", async () => {
    const deviceId = randomUUID();
    const adoptedSessionKey = "agent:main:subagent:uuid";
    const entry = createAllowlistEntry({
      deviceId,
      userId: "flynn",
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry], {
      sessionStorePathRelative: path.join("agents", "main", "sessions", "sessions.json"),
    });
    try {
      await fs.writeFile(
        ctx.sessionStorePath,
        JSON.stringify(
          {
            [adoptedSessionKey]: {
              sessionId: "sess_subagent",
              updatedAt: Date.now() - 100,
              label: "Subagent Session",
              channel: "openclaw",
              lastChannel: "openclaw",
              lastTo: adoptedSessionKey,
            },
          },
          null,
          2,
        ),
      );

      const pair = await performPairRequest(ctx.port, deviceId);
      const token = pair.token as string;
      const authed = await authenticateDevice(ctx.port, deviceId, token);
      const adoptResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams/adopt`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionKey: adoptedSessionKey }),
      });
      expect(adoptResponse.status).toBe(200);

      const result = await ctx.server.sendMessage({
        target: adoptedSessionKey,
        text: "hello adopted stream",
      });

      expect(result.userId).toBe(entry.userId);
      expect(result.deviceId).toBeUndefined();

      const dbPath = path.join(path.dirname(ctx.allowlistPath), "clawline.sqlite");
      const db = new BetterSqlite3(dbPath);
      try {
        const row = db
          .prepare(`SELECT userId, sessionKey, payloadJson FROM events WHERE id = ?`)
          .get(result.messageId) as { userId: string; sessionKey: string; payloadJson: string };
        expect(row.userId).toBe(entry.userId);
        expect(JSON.parse(row.payloadJson)).toMatchObject({
          content: "hello adopted stream",
          sessionKey: adoptedSessionKey,
        });
      } finally {
        db.close();
      }
      authed.ws.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("untracks adopted sessions via DELETE without crashing", async () => {
    const deviceId = randomUUID();
    const adoptedSessionKey = "agent:main:subagent:uuid";
    const entry = createAllowlistEntry({
      deviceId,
      userId: "flynn",
      isAdmin: true,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      await fs.writeFile(
        ctx.sessionStorePath,
        JSON.stringify(
          {
            [adoptedSessionKey]: {
              sessionId: "sess_subagent",
              updatedAt: Date.now() - 100,
              label: "Subagent Session",
              channel: "openclaw",
              lastChannel: "openclaw",
              lastTo: adoptedSessionKey,
            },
          },
          null,
          2,
        ),
      );

      const pair = await performPairRequest(ctx.port, deviceId);
      const token = pair.token as string;
      const authed = await authenticateDevice(ctx.port, deviceId, token);

      const adoptResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams/adopt`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionKey: adoptedSessionKey }),
      });
      expect(adoptResponse.status).toBe(200);

      const deleteResponse = await fetch(
        `http://127.0.0.1:${ctx.port}/api/streams/${encodeURIComponent(adoptedSessionKey)}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Clawline-User-Action": "delete_stream",
          },
        },
      );
      expect(deleteResponse.status).toBe(200);
      expect(await deleteResponse.json()).toMatchObject({
        deletedSessionKey: adoptedSessionKey,
      });

      const dbPath = path.join(path.dirname(ctx.allowlistPath), "clawline.sqlite");
      const db = new BetterSqlite3(dbPath, { readonly: true });
      try {
        const adoptedRows = db
          .prepare(`SELECT userId, sessionKey FROM adopted_sessions WHERE userId = ?`)
          .all("flynn") as Array<{ userId: string; sessionKey: string }>;
        expect(adoptedRows).toEqual([]);
        const streamRows = db
          .prepare(`SELECT sessionKey FROM stream_sessions WHERE userId = ? AND sessionKey = ?`)
          .all("flynn", adoptedSessionKey) as Array<{ sessionKey: string }>;
        expect(streamRows).toEqual([]);
      } finally {
        db.close();
      }

      authed.ws.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("rejects adopted session recording for non-admin users", async () => {
    const deviceId = randomUUID();
    const adoptedSessionKey = "agent:main:subagent:uuid";
    const entry = createAllowlistEntry({
      deviceId,
      userId: "flynn",
      isAdmin: false,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      await fs.writeFile(
        ctx.sessionStorePath,
        JSON.stringify(
          {
            [adoptedSessionKey]: {
              sessionId: "sess_subagent",
              updatedAt: Date.now() - 100,
              label: "Subagent Session",
              channel: "openclaw",
              lastChannel: "openclaw",
              lastTo: adoptedSessionKey,
            },
          },
          null,
          2,
        ),
      );

      const pair = await performPairRequest(ctx.port, deviceId);
      const token = pair.token as string;
      const { ws } = await authenticateDevice(ctx.port, deviceId, token);
      const response = await fetch(`http://127.0.0.1:${ctx.port}/api/streams/adopt`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionKey: adoptedSessionKey }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "forbidden", message: "Admin access required" },
      });
      ws.terminate();
    } finally {
      await ctx.cleanup();
    }
  });
  it("accepts multiply-encoded stream session keys for rename and delete", async () => {
    const deviceId = randomUUID();
    const entry = createAllowlistEntry({
      deviceId,
      userId: "flynn",
      isAdmin: false,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const pair = await performPairRequest(ctx.port, deviceId);
      const token = pair.token as string;
      const { ws } = await authenticateDevice(ctx.port, deviceId, token);
      const queue = createMessageQueue(ws);

      const createResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idempotencyKey: "req_create_double_encode",
          displayName: "Double Encode",
        }),
      });
      expect(createResponse.status).toBe(201);
      const createdPayload = (await createResponse.json()) as {
        stream: { sessionKey: string };
      };
      const createdSessionKey = createdPayload.stream.sessionKey;
      await queue.next();

      const encodedKey = encodeURIComponent(createdSessionKey);
      const doubleEncodedKey = encodeURIComponent(encodedKey);
      const tripleEncodedKey = encodeURIComponent(doubleEncodedKey);

      const renameResponse = await fetch(
        `http://127.0.0.1:${ctx.port}/api/streams/${doubleEncodedKey}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ displayName: "Renamed via double encode" }),
        },
      );
      expect(renameResponse.status).toBe(200);
      const renamedPayload = (await renameResponse.json()) as {
        stream: { sessionKey: string; displayName: string };
      };
      expect(renamedPayload.stream.sessionKey).toBe(createdSessionKey);
      expect(renamedPayload.stream.displayName).toBe("Renamed via double encode");
      expect(await queue.next()).toMatchObject({
        type: "stream_updated",
        stream: { sessionKey: createdSessionKey, displayName: "Renamed via double encode" },
      });

      const deleteResponse = await fetch(
        `http://127.0.0.1:${ctx.port}/api/streams/${tripleEncodedKey}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ idempotencyKey: "req_delete_double_encode" }),
        },
      );
      expect(deleteResponse.status).toBe(200);
      const deletePayload = (await deleteResponse.json()) as { deletedSessionKey: string };
      expect(deletePayload.deletedSessionKey).toBe(createdSessionKey);
      expect(await queue.next()).toMatchObject({
        type: "stream_deleted",
        sessionKey: createdSessionKey,
      });

      queue.dispose();
      ws.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("returns stream_not_found for malformed mutation keys instead of mutating built-ins", async () => {
    const deviceId = randomUUID();
    const entry = createAllowlistEntry({
      deviceId,
      userId: "flynn",
      isAdmin: false,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const pair = await performPairRequest(ctx.port, deviceId);
      const token = pair.token as string;
      const { ws } = await authenticateDevice(ctx.port, deviceId, token);

      const renameResponse = await fetch(
        `http://127.0.0.1:${ctx.port}/api/streams/${encodeURIComponent("%%%")}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ displayName: "Should not apply" }),
        },
      );
      expect(renameResponse.status).toBe(400);
      const renamePayload = (await renameResponse.json()) as {
        error: { code: string; message: string };
      };
      expect(renamePayload.error.code).toBe("invalid_session_key");

      const deleteResponse = await fetch(
        `http://127.0.0.1:${ctx.port}/api/streams/${encodeURIComponent("agent:bad:key")}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ idempotencyKey: "req_bad_key_delete" }),
        },
      );
      expect(deleteResponse.status).toBe(404);
      const deletePayload = (await deleteResponse.json()) as {
        error: { code: string; message: string };
      };
      expect(deletePayload.error.code).toBe("stream_not_found");
      ws.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("enforces stream API edge cases for built-ins, idempotency reuse, and deleted stream sends", async () => {
    const deviceId = randomUUID();
    const entry = createAllowlistEntry({
      deviceId,
      userId: "flynn",
      isAdmin: false,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const pair = await performPairRequest(ctx.port, deviceId);
      const token = pair.token as string;
      const { ws: streamWs } = await authenticateDevice(ctx.port, deviceId, token);
      const listResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const listPayload = (await listResponse.json()) as {
        streams: Array<{ sessionKey: string }>;
      };
      const mainKey = listPayload.streams[0]?.sessionKey;
      expect(mainKey).toBe("agent:main:clawline:flynn:main");

      const renameBuiltIn = await fetch(
        `http://127.0.0.1:${ctx.port}/api/streams/${encodeURIComponent(mainKey)}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ displayName: "Nope" }),
        },
      );
      expect(renameBuiltIn.status).toBe(409);
      expect(await renameBuiltIn.json()).toEqual({
        error: {
          code: "built_in_stream_rename_forbidden",
          message: "Built-in streams cannot be renamed",
        },
      });

      const deleteBuiltIn = await fetch(
        `http://127.0.0.1:${ctx.port}/api/streams/${encodeURIComponent(mainKey)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      expect(deleteBuiltIn.status).toBe(409);
      expect(await deleteBuiltIn.json()).toEqual({
        error: {
          code: "built_in_stream_delete_forbidden",
          message: "Built-in streams cannot be deleted",
        },
      });

      const createOnce = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idempotencyKey: "req_create_once",
          displayName: "Scratch",
        }),
      });
      expect(createOnce.status).toBe(201);
      const created = (await createOnce.json()) as { stream: { sessionKey: string } };

      const createRetry = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idempotencyKey: "req_create_once",
          displayName: "Scratch",
        }),
      });
      expect(createRetry.status).toBe(201);
      expect(await createRetry.json()).toEqual(created);

      const createConflict = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idempotencyKey: "req_create_once",
          displayName: "Different",
        }),
      });
      expect(createConflict.status).toBe(409);
      expect(await createConflict.json()).toEqual({
        error: {
          code: "idempotency_key_reused",
          message: "Idempotency key was already used",
        },
      });

      const deleteOnce = await fetch(
        `http://127.0.0.1:${ctx.port}/api/streams/${encodeURIComponent(created.stream.sessionKey)}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ idempotencyKey: "req_delete_once" }),
        },
      );
      expect(deleteOnce.status).toBe(200);

      const deleteRetry = await fetch(
        `http://127.0.0.1:${ctx.port}/api/streams/${encodeURIComponent(created.stream.sessionKey)}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ idempotencyKey: "req_delete_once" }),
        },
      );
      expect(deleteRetry.status).toBe(200);
      expect(await deleteRetry.json()).toEqual({
        deletedSessionKey: created.stream.sessionKey,
      });

      const crossOperationConflict = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idempotencyKey: "req_delete_once",
          displayName: "Other",
        }),
      });
      expect(crossOperationConflict.status).toBe(409);
      expect(await crossOperationConflict.json()).toEqual({
        error: {
          code: "idempotency_key_reused",
          message: "Idempotency key was already used",
        },
      });

      streamWs.send(
        JSON.stringify({
          type: "message",
          id: `c_${randomUUID()}`,
          content: "to deleted stream",
          sessionKey: created.stream.sessionKey,
        }),
      );
      const wsResponse = await waitForMessage(streamWs);
      expect(wsResponse).toMatchObject({
        type: "error",
        code: "stream_not_found",
      });
      streamWs.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("migrates legacy events into stream metadata and backfills events.sessionKey", async () => {
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      userId: "flynn",
      isAdmin: false,
      tokenDelivered: true,
    });
    const customSessionKey = "agent:main:clawline:flynn:s_deadbeef";
    const adoptedSessionKey = "agent:main:subagent:legacy";
    const ctx = await setupTestServer([entry], {
      seedLegacyDatabase: async (dbPath) => {
        const db = new BetterSqlite3(dbPath);
        try {
          db.exec(`
            CREATE TABLE user_sequences (
              userId TEXT PRIMARY KEY,
              nextSequence INTEGER NOT NULL
            );
            CREATE TABLE events (
              id TEXT PRIMARY KEY,
              userId TEXT NOT NULL,
              sequence INTEGER NOT NULL,
              originatingDeviceId TEXT,
              payloadJson TEXT NOT NULL,
              payloadBytes INTEGER NOT NULL,
              timestamp INTEGER NOT NULL
            );
            CREATE UNIQUE INDEX idx_events_userId_sequence ON events(userId, sequence);
            CREATE INDEX idx_events_userId ON events(userId);
            CREATE TABLE messages (
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
            CREATE INDEX idx_messages_userId ON messages(userId);
            CREATE INDEX idx_messages_serverEventId ON messages(serverEventId);
            CREATE TABLE assets (
              assetId TEXT PRIMARY KEY,
              userId TEXT NOT NULL,
              mimeType TEXT NOT NULL,
              size INTEGER NOT NULL,
              createdAt INTEGER NOT NULL,
              uploaderDeviceId TEXT NOT NULL
            );
            CREATE INDEX idx_assets_userId ON assets(userId);
            CREATE INDEX idx_assets_createdAt ON assets(createdAt);
            CREATE TABLE message_assets (
              deviceId TEXT NOT NULL,
              clientId TEXT NOT NULL,
              assetId TEXT NOT NULL,
              PRIMARY KEY (deviceId, clientId, assetId),
              FOREIGN KEY (deviceId, clientId) REFERENCES messages(deviceId, clientId) ON DELETE CASCADE,
              FOREIGN KEY (assetId) REFERENCES assets(assetId) ON DELETE RESTRICT
            );
            CREATE INDEX idx_message_assets_assetId ON message_assets(assetId);
            CREATE TABLE stream_sessions (
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
            CREATE INDEX idx_stream_sessions_user_order
              ON stream_sessions(userId, orderIndex);
          `);
          const payload = JSON.stringify({
            type: "message",
            id: "s_00000000-0000-0000-0000-000000000001",
            role: "assistant",
            content: "legacy",
            timestamp: 1,
            streaming: false,
            sessionKey: customSessionKey,
          });
          db.prepare(
            `INSERT INTO events
              (id, userId, sequence, originatingDeviceId, payloadJson, payloadBytes, timestamp)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            "s_00000000-0000-0000-0000-000000000001",
            "flynn",
            1,
            null,
            payload,
            Buffer.byteLength(payload, "utf8"),
            1,
          );
          db.prepare(
            `INSERT INTO stream_sessions
              (userId, sessionKey, displayName, kind, orderIndex, isBuiltIn, createdAt, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run("flynn", adoptedSessionKey, "Legacy adopted", "custom", 0, 0, 1, 1);
        } finally {
          db.close();
        }
      },
    });
    try {
      const pair = await performPairRequest(ctx.port, entry.deviceId);
      const token = pair.token as string;
      const { ws } = await authenticateDevice(ctx.port, entry.deviceId, token);
      const streamsResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(streamsResponse.status).toBe(200);
      const streamsPayload = (await streamsResponse.json()) as {
        streams: Array<{ sessionKey: string; kind: string; displayName: string }>;
      };
      expect(streamsPayload.streams).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionKey: "agent:main:clawline:flynn:main",
            kind: "main",
            displayName: "Personal",
          }),
        ]),
      );
      expect(streamsPayload.streams.some((stream) => stream.sessionKey === customSessionKey)).toBe(
        true,
      );
      expect(
        streamsPayload.streams.some(
          (stream) => stream.sessionKey === customSessionKey && stream.kind === "custom",
        ),
      ).toBe(true);
      expect(
        streamsPayload.streams.some(
          (stream: { sessionKey: string; adopted?: boolean }) =>
            stream.sessionKey === adoptedSessionKey && stream.adopted === true,
        ),
      ).toBe(true);

      const dbPath = path.join(path.dirname(ctx.allowlistPath), "clawline.sqlite");
      const db = new BetterSqlite3(dbPath, { readonly: true });
      try {
        const userVersion = db.pragma("user_version", { simple: true }) as number;
        expect(userVersion).toBe(5);
        const eventsColumns = db.prepare(`PRAGMA table_info(events)`).all() as Array<{
          name: string;
        }>;
        expect(eventsColumns.some((col) => col.name === "eventType")).toBe(true);
        expect(eventsColumns.some((col) => col.name === "sessionKey")).toBe(true);
        const row = db
          .prepare(`SELECT sessionKey, eventType FROM events WHERE id = ?`)
          .get("s_00000000-0000-0000-0000-000000000001") as
          | { sessionKey: string; eventType: string }
          | undefined;
        expect(row?.sessionKey).toBe(customSessionKey);
        expect(row?.eventType).toBe("message");
        const adoptedRow = db
          .prepare(`SELECT adopted FROM stream_sessions WHERE userId = ? AND sessionKey = ?`)
          .get("flynn", adoptedSessionKey) as { adopted: number } | undefined;
        expect(adoptedRow?.adopted).toBe(1);
      } finally {
        db.close();
      }
      ws.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("serves /www root index with caching headers and HEAD support", async () => {
    const ctx = await setupTestServer();
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/www`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("max-age=60");
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("root index");
      const indexResponse = await fetch(`http://127.0.0.1:${ctx.port}/www/index.html`);
      expect(await indexResponse.text()).toContain("root index");
      const headResponse = await fetch(`http://127.0.0.1:${ctx.port}/www`, { method: "HEAD" });
      expect(headResponse.status).toBe(200);
      expect(await headResponse.text()).toBe("");
    } finally {
      await ctx.cleanup();
    }
  });

  it("/www blocks dotfiles, traversal, symlink escapes, and directories without index", async () => {
    const ctx = await setupTestServer();
    try {
      await fs.writeFile(path.join(ctx.webRootPath, ".secret"), "hidden");
      const dotResponse = await fetch(`http://127.0.0.1:${ctx.port}/www/.secret`);
      expect(dotResponse.status).toBe(404);
      const traversalResponse = await fetch(
        `http://127.0.0.1:${ctx.port}/www/../state/allowlist.json`,
      );
      expect(traversalResponse.status).toBe(404);
      const emptyDir = path.join(ctx.webRootPath, "emptydir");
      await fs.mkdir(emptyDir, { recursive: true });
      const emptyDirResponse = await fetch(`http://127.0.0.1:${ctx.port}/www/emptydir/`);
      expect(emptyDirResponse.status).toBe(404);
      const subdirPath = path.join(ctx.webRootPath, "subdir");
      await fs.mkdir(subdirPath, { recursive: true });
      await fs.writeFile(path.join(subdirPath, "index.html"), "sub index");
      const subdirResponse = await fetch(`http://127.0.0.1:${ctx.port}/www/subdir`);
      expect(await subdirResponse.text()).toBe("sub index");
      if (process.platform !== "win32") {
        const outsideFile = path.join(path.dirname(ctx.webRootPath), "outside.txt");
        await fs.writeFile(outsideFile, "leak");
        const linkPath = path.join(ctx.webRootPath, "leak");
        await fs.symlink(outsideFile, linkPath);
        const symlinkResponse = await fetch(`http://127.0.0.1:${ctx.port}/www/leak`);
        expect(symlinkResponse.status).toBe(404);
      }
    } finally {
      await ctx.cleanup();
    }
  });

  it("/www follows symlinks outside webroot when enabled (still blocks dotfiles)", async () => {
    if (process.platform === "win32") {
      return;
    }
    const ctx = await setupTestServer([], { webRootFollowSymlinks: true });
    try {
      const outsideFile = path.join(path.dirname(ctx.webRootPath), "outside.txt");
      await fs.writeFile(outsideFile, "leak");
      const linkPath = path.join(ctx.webRootPath, "leak");
      await fs.symlink(outsideFile, linkPath);
      const response = await fetch(`http://127.0.0.1:${ctx.port}/www/leak`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("leak");

      const outsideDotfile = path.join(path.dirname(ctx.webRootPath), ".dotsecret");
      await fs.writeFile(outsideDotfile, "hidden");
      const dotLinkPath = path.join(ctx.webRootPath, "dotsecret");
      await fs.symlink(outsideDotfile, dotLinkPath);
      const dotResponse = await fetch(`http://127.0.0.1:${ctx.port}/www/dotsecret`);
      expect(dotResponse.status).toBe(404);
    } finally {
      await ctx.cleanup();
    }
  });

  it("/www serves from a dot-directory webRootPath (followSymlinks=false)", async () => {
    const ctx = await setupTestServer([], { webRootPathRelative: ".openclaw/workspace/www" });
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/www/index.html`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("root index");
    } finally {
      await ctx.cleanup();
    }
  });

  it("T073: create then immediately delete child stream succeeds deterministically", async () => {
    const deviceId = randomUUID();
    const entry = createAllowlistEntry({
      deviceId,
      userId: "flynn",
      isAdmin: false,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const pair = await performPairRequest(ctx.port, deviceId);
      const token = pair.token as string;
      const { ws } = await authenticateDevice(ctx.port, deviceId, token);

      // Rapid create+delete cycles to expose timing/normalization issues
      for (let i = 0; i < 5; i++) {
        const createResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            idempotencyKey: `req_create_t073_${i}`,
            displayName: `Test Stream ${i}`,
          }),
        });
        expect(createResponse.status).toBe(201);
        const created = (await createResponse.json()) as { stream: { sessionKey: string } };
        const sessionKey = created.stream.sessionKey;

        // Delete immediately (no delay) — this is the T073 repro condition
        const encodedKey = encodeURIComponent(sessionKey);
        const deleteResponse = await fetch(
          `http://127.0.0.1:${ctx.port}/api/streams/${encodedKey}`,
          {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ idempotencyKey: `req_delete_t073_${i}` }),
          },
        );
        expect(deleteResponse.status).toBe(200);
        const deleted = (await deleteResponse.json()) as { deletedSessionKey: string };
        expect(deleted.deletedSessionKey).toBe(sessionKey);

        // Verify stream is gone
        const listResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const list = (await listResponse.json()) as { streams: Array<{ sessionKey: string }> };
        expect(list.streams.find((s) => s.sessionKey === sessionKey)).toBeUndefined();
      }
      ws.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("T073: concurrent create+delete from two sockets is serialized correctly", async () => {
    const deviceId1 = randomUUID();
    const deviceId2 = randomUUID();
    const entry1 = createAllowlistEntry({
      deviceId: deviceId1,
      userId: "flynn",
      isAdmin: false,
      tokenDelivered: true,
    });
    const entry2 = createAllowlistEntry({
      deviceId: deviceId2,
      userId: "flynn",
      isAdmin: false,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry1, entry2]);
    try {
      const pair1 = await performPairRequest(ctx.port, deviceId1);
      const pair2 = await performPairRequest(ctx.port, deviceId2);
      const token1 = pair1.token as string;
      const token2 = pair2.token as string;
      const { ws: ws1 } = await authenticateDevice(ctx.port, deviceId1, token1);
      const { ws: ws2 } = await authenticateDevice(ctx.port, deviceId2, token2);

      // Create from device 1
      const createResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token1}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idempotencyKey: "req_create_concurrent",
          displayName: "Concurrent Test",
        }),
      });
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as { stream: { sessionKey: string } };

      // Delete from device 2 immediately
      const encodedKey = encodeURIComponent(created.stream.sessionKey);
      const deleteResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams/${encodedKey}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token2}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ idempotencyKey: "req_delete_concurrent" }),
      });
      expect(deleteResponse.status).toBe(200);
      ws1.terminate();
      ws2.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("T073: delete of already-deleted stream returns 404 without idempotency", async () => {
    const deviceId = randomUUID();
    const entry = createAllowlistEntry({
      deviceId,
      userId: "flynn",
      isAdmin: false,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry]);
    try {
      const pair = await performPairRequest(ctx.port, deviceId);
      const token = pair.token as string;
      const { ws } = await authenticateDevice(ctx.port, deviceId, token);

      // Create
      const createResponse = await fetch(`http://127.0.0.1:${ctx.port}/api/streams`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idempotencyKey: "req_create_double_del",
          displayName: "Double Delete Test",
        }),
      });
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as { stream: { sessionKey: string } };
      const encodedKey = encodeURIComponent(created.stream.sessionKey);

      // First delete
      const del1 = await fetch(`http://127.0.0.1:${ctx.port}/api/streams/${encodedKey}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ idempotencyKey: "req_del_1" }),
      });
      expect(del1.status).toBe(200);

      // Second delete with different idempotency key → should be 404
      const del2 = await fetch(`http://127.0.0.1:${ctx.port}/api/streams/${encodedKey}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ idempotencyKey: "req_del_2" }),
      });
      expect(del2.status).toBe(404);
      const payload = (await del2.json()) as { error: { code: string } };
      expect(payload.error.code).toBe("stream_not_found");
      ws.terminate();
    } finally {
      await ctx.cleanup();
    }
  });

  it("/www serves from a dot-directory webRootPath (followSymlinks=true)", async () => {
    const ctx = await setupTestServer([], {
      webRootFollowSymlinks: true,
      webRootPathRelative: ".openclaw/workspace/www",
    });
    try {
      const response = await fetch(`http://127.0.0.1:${ctx.port}/www/index.html`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("root index");
    } finally {
      await ctx.cleanup();
    }
  });

  it("T001: on-demand terminal session stays alive so terminal_ready is returned (not terminal_error)", async () => {
    // This test verifies the sentinel-shell fix: ensureTmuxSessionExists now passes
    // an explicit shell command to `tmux new-session -d -s <name> <shell>` so the
    // pane stays alive in headless/daemon environments, allowing resolveTmuxPaneId
    // to succeed on the second call and the WS handshake to return terminal_ready.
    const { execFile: execFileCb } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFile = promisify(execFileCb);

    // Skip if tmux not found on this machine.
    let tmuxPath: string;
    try {
      const { stdout } = await execFile("which", ["tmux"]);
      tmuxPath = stdout.trim();
    } catch {
      console.warn("Skipping T001 terminal test: tmux not found");
      return;
    }
    if (!tmuxPath) {
      console.warn("Skipping T001 terminal test: tmux not found");
      return;
    }

    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      isAdmin: false,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry], {
      terminalTmux: { mode: "local" },
    });

    // The tmux session name will equal the terminalSessionId we generate.
    const terminalSessionId = `term_t001_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

    try {
      // Register the terminal session by sending a message with a terminal descriptor.
      const descriptor = { terminalSessionId, title: "T001 test session", version: 1 };
      const base64 = Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64");
      await ctx.server.sendMessage({
        target: entry.userId,
        text: "terminal",
        attachments: [
          {
            data: base64,
            mimeType: "application/vnd.clawline.terminal-session+json",
          },
        ],
      });

      // Build a JWT auth token for the terminal WS.
      const statePath = path.dirname(ctx.allowlistPath);
      const jwtKey = (await fs.readFile(path.join(statePath, "jwt.key"), "utf8")).trim();
      const authToken = jwt.sign(
        { sub: entry.userId, deviceId: entry.deviceId, isAdmin: entry.isAdmin },
        jwtKey,
        { algorithm: "HS256" },
      );

      // Open the terminal WebSocket and send terminal_auth.
      const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws/terminal`);
      await waitForOpen(ws);

      // Collect JSON messages; ignore binary frames (PTY output after auth).
      const jsonMessages: unknown[] = [];
      const messagePromise = new Promise<unknown>((resolve) => {
        ws.on("message", (raw, isBinary) => {
          if (isBinary) {
            return;
          } // PTY output after auth — skip
          try {
            const parsed = JSON.parse(decodeRawData(raw));
            jsonMessages.push(parsed);
            // Resolve on the first JSON message that has a type.
            if (parsed && typeof parsed === "object" && "type" in (parsed as object)) {
              resolve(parsed);
            }
          } catch {
            // non-JSON text frame — ignore
          }
        });
      });

      ws.send(
        JSON.stringify({
          type: "terminal_auth",
          protocolVersion: PROTOCOL_VERSION,
          terminalSessionId,
          deviceId: entry.deviceId,
          authToken,
          cols: 80,
          rows: 24,
          backfillLines: 0,
        }),
      );

      // Wait up to 10 s for the auth response.
      const response = await Promise.race([
        messagePromise,
        new Promise<{ type: string; message?: string }>((_, reject) =>
          setTimeout(
            () => reject(new Error("Timed out waiting for terminal auth response")),
            10_000,
          ),
        ),
      ]);

      ws.terminate();

      // Assert: must be terminal_ready, not terminal_error.
      expect((response as { type: string }).type).toBe("terminal_ready");
    } finally {
      // Best-effort cleanup: kill the tmux session we created on-demand.
      try {
        await execFile("tmux", ["kill-session", "-t", terminalSessionId]);
      } catch {
        // session may not exist if test failed before creation — that's fine
      }
      await ctx.cleanup();
    }
  }, 30_000); // 30-second timeout for tmux startup

  it("routes version 2 terminal sessions per bubble destination instead of the global ssh target", async () => {
    if (!(await ensureTmuxAvailable())) {
      console.warn("Skipping terminal routing test: tmux not found");
      return;
    }

    const fakeSsh = await setupFakeSshProxy();
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      isAdmin: false,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry], {
      terminalTmux: { mode: "ssh", sshTarget: "global.invalid" },
    });
    const terminalSessionIds = [
      `term_route_a_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
      `term_route_b_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
    ];
    const firstTerminalSessionId = terminalSessionIds[0];

    try {
      for (const [index, terminalSessionId] of terminalSessionIds.entries()) {
        const destinationAddress = index === 0 ? "mike@eezo" : "mike@tars";
        const descriptor = {
          terminalSessionId,
          title: destinationAddress,
          version: 2,
          destination: { address: destinationAddress },
        };
        const base64 = Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64");
        await ctx.server.sendMessage({
          target: entry.userId,
          text: "terminal",
          attachments: [
            {
              data: base64,
              mimeType: "application/vnd.clawline.terminal-session+json",
            },
          ],
        });

        const { ws, response } = await authenticateTerminalSession({
          port: ctx.port,
          allowlistPath: ctx.allowlistPath,
          entry,
          terminalSessionId,
        });
        expect((response as { type: string }).type).toBe("terminal_ready");
        ws.terminate();
      }

      if (!firstTerminalSessionId) {
        throw new Error("Expected first terminal session id");
      }
      const reattach = await authenticateTerminalSession({
        port: ctx.port,
        allowlistPath: ctx.allowlistPath,
        entry,
        terminalSessionId: firstTerminalSessionId,
      });
      expect((reattach.response as { type: string }).type).toBe("terminal_ready");
      reattach.ws.terminate();

      const targets = await readFakeSshTargets(fakeSsh.logPath);
      expect(targets).toContain("mike@eezo");
      expect(targets).toContain("mike@tars");
      expect(targets.at(-1)).toBe("mike@eezo");
      expect(targets).not.toContain("global.invalid");
    } finally {
      for (const terminalSessionId of terminalSessionIds) {
        await killLocalTmuxSession(terminalSessionId);
      }
      await ctx.cleanup();
      await fakeSsh.cleanup();
    }
  }, 30_000);

  it("creates destination-aware terminal bubbles from structured action requests and preserves routing through reattach and restart", async () => {
    if (!(await ensureTmuxAvailable())) {
      console.warn("Skipping terminal action routing test: tmux not found");
      return;
    }

    const fakeSsh = await setupFakeSshProxy();
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      isAdmin: false,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry], {
      terminalTmux: { mode: "ssh", sshTarget: "global.invalid" },
    });
    const outboundResults: ClawlineOutboundSendResult[] = [];
    let restartedServer: ProviderServer | null = null;

    try {
      setClawlineOutboundSender(async (payload) => {
        const result = await ctx.server.sendMessage(payload);
        outboundResults.push(result);
        return result;
      });

      const handleAction = clawlineMessageActions.handleAction;
      if (!handleAction) {
        throw new Error("Expected Clawline handleAction to exist");
      }

      await handleAction({
        channel: "clawline",
        action: "sendAttachment",
        params: {
          target: entry.userId,
          mimeType: "application/vnd.clawline.terminal-session+json",
          title: "eezo shell",
          destination: {
            address: "mike@eezo",
          },
        },
        cfg: testOpenClawConfig,
        accountId: null,
      });
      await handleAction({
        channel: "clawline",
        action: "sendAttachment",
        params: {
          target: entry.userId,
          mimeType: "application/vnd.clawline.terminal-session+json",
          destination: {
            address: "mike@tars",
          },
        },
        cfg: testOpenClawConfig,
        accountId: null,
      });

      expect(outboundResults).toHaveLength(2);
      const descriptors = outboundResults.map(decodeTerminalDescriptorFromResult);
      const firstDescriptor = descriptors[0];
      expect(descriptors[0]?.version).toBe(2);
      expect(descriptors[0]?.title).toBe("eezo shell");
      expect(descriptors[0]?.destination?.address).toBe("mike@eezo");
      expect(descriptors[1]?.version).toBe(2);
      expect(descriptors[1]?.title).toBe("mike@tars");
      expect(descriptors[1]?.destination?.address).toBe("mike@tars");

      for (const descriptor of descriptors) {
        const { ws, response } = await authenticateTerminalSession({
          port: ctx.port,
          allowlistPath: ctx.allowlistPath,
          entry,
          terminalSessionId: descriptor.terminalSessionId,
        });
        expect((response as { type: string }).type).toBe("terminal_ready");
        ws.terminate();
      }

      if (!firstDescriptor) {
        throw new Error("Expected first terminal descriptor");
      }
      const reattach = await authenticateTerminalSession({
        port: ctx.port,
        allowlistPath: ctx.allowlistPath,
        entry,
        terminalSessionId: firstDescriptor.terminalSessionId,
      });
      expect((reattach.response as { type: string }).type).toBe("terminal_ready");
      reattach.ws.terminate();

      await ctx.server.stop();
      restartedServer = await createProviderServer({
        config: {
          port: 0,
          statePath: path.dirname(ctx.allowlistPath),
          media: {
            storagePath: ctx.mediaPath,
            maxInlineBytes: 256_000,
            maxUploadBytes: 8_000_000,
            unreferencedUploadTtlSeconds: 86_400,
          },
          alertInstructionsPath: ctx.alertInstructionsPath,
          webRootPath: ctx.webRootPath,
          terminal: {
            tmux: {
              mode: "ssh",
              ssh: {
                target: "global.invalid",
              },
            },
          },
        },
        openClawConfig: testOpenClawConfig,
        replyResolver: testReplyResolver,
        logger: silentLogger,
        sessionStorePath: ctx.sessionStorePath,
      });
      await restartedServer.start();

      const restartedAuth = await authenticateTerminalSession({
        port: restartedServer.getPort(),
        allowlistPath: ctx.allowlistPath,
        entry,
        terminalSessionId: firstDescriptor.terminalSessionId,
      });
      expect((restartedAuth.response as { type: string }).type).toBe("terminal_ready");
      restartedAuth.ws.terminate();

      const targets = await readFakeSshTargets(fakeSsh.logPath);
      expect(targets).toContain("mike@eezo");
      expect(targets).toContain("mike@tars");
      expect(targets.at(-1)).toBe("mike@eezo");
      expect(targets).not.toContain("global.invalid");
    } finally {
      setClawlineOutboundSender(null);
      for (const result of outboundResults) {
        try {
          await killLocalTmuxSession(decodeTerminalDescriptorFromResult(result).terminalSessionId);
        } catch {
          // Best effort cleanup.
        }
      }
      if (restartedServer) {
        await restartedServer.stop();
      }
      await ctx.cleanup();
      await fakeSsh.cleanup();
    }
  }, 30_000);

  it("ignores client-sent destination hints during terminal_auth and routes by the persisted session record", async () => {
    if (!(await ensureTmuxAvailable())) {
      console.warn("Skipping terminal auth routing-authority test: tmux not found");
      return;
    }

    const fakeSsh = await setupFakeSshProxy();
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      isAdmin: false,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry], {
      terminalTmux: { mode: "ssh", sshTarget: "global.invalid" },
    });
    const terminalSessionId = `term_auth_hint_${randomUUID().replace(/-/g, "").slice(0, 10)}`;

    try {
      const descriptor = {
        terminalSessionId,
        title: "eezo shell",
        version: 2,
        destination: { address: "mike@eezo" },
      };
      const base64 = Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64");
      await ctx.server.sendMessage({
        target: entry.userId,
        text: "terminal",
        attachments: [
          {
            data: base64,
            mimeType: "application/vnd.clawline.terminal-session+json",
          },
        ],
      });

      const { ws, response } = await authenticateTerminalSession({
        port: ctx.port,
        allowlistPath: ctx.allowlistPath,
        entry,
        terminalSessionId,
        authPayloadExtras: {
          destination: { address: "mike@tars" },
        },
      });
      expect((response as { type: string }).type).toBe("terminal_ready");
      ws.terminate();

      const targets = await readFakeSshTargets(fakeSsh.logPath);
      expect(targets).toContain("mike@eezo");
      expect(targets).not.toContain("mike@tars");
      expect(targets).not.toContain("global.invalid");
    } finally {
      await killLocalTmuxSession(terminalSessionId);
      await ctx.cleanup();
      await fakeSsh.cleanup();
    }
  }, 30_000);

  it("keeps version 1 terminal sessions on the configured global ssh target as compatibility fallback", async () => {
    if (!(await ensureTmuxAvailable())) {
      console.warn("Skipping terminal routing fallback test: tmux not found");
      return;
    }

    const fakeSsh = await setupFakeSshProxy();
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      isAdmin: false,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry], {
      terminalTmux: { mode: "ssh", sshTarget: "global.invalid" },
    });
    const terminalSessionId = `term_v1_${randomUUID().replace(/-/g, "").slice(0, 10)}`;

    try {
      const descriptor = {
        terminalSessionId,
        title: "legacy terminal",
        version: 1,
      };
      const base64 = Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64");
      await ctx.server.sendMessage({
        target: entry.userId,
        text: "terminal",
        attachments: [
          {
            data: base64,
            mimeType: "application/vnd.clawline.terminal-session+json",
          },
        ],
      });

      const { ws, response } = await authenticateTerminalSession({
        port: ctx.port,
        allowlistPath: ctx.allowlistPath,
        entry,
        terminalSessionId,
      });
      expect((response as { type: string }).type).toBe("terminal_ready");
      ws.terminate();

      const targets = await readFakeSshTargets(fakeSsh.logPath);
      expect(targets).toContain("global.invalid");
    } finally {
      await killLocalTmuxSession(terminalSessionId);
      await ctx.cleanup();
      await fakeSsh.cleanup();
    }
  }, 30_000);

  it("fails a version 2 terminal bubble on its explicit destination instead of silently rerouting through the global ssh target", async () => {
    if (!(await ensureTmuxAvailable())) {
      console.warn("Skipping terminal routing failure test: tmux not found");
      return;
    }

    const fakeSsh = await setupFakeSshProxy();
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      isAdmin: false,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry], {
      terminalTmux: { mode: "ssh", sshTarget: "global.invalid" },
    });
    const terminalSessionId = `term_fail_${randomUUID().replace(/-/g, "").slice(0, 10)}`;

    try {
      process.env.FAKE_SSH_FAIL_TARGET = "missing-host.invalid";
      const descriptor = {
        terminalSessionId,
        title: "missing-host",
        version: 2,
        destination: { address: "missing-host.invalid" },
      };
      const base64 = Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64");
      await ctx.server.sendMessage({
        target: entry.userId,
        text: "terminal",
        attachments: [
          {
            data: base64,
            mimeType: "application/vnd.clawline.terminal-session+json",
          },
        ],
      });

      const { ws, response } = await authenticateTerminalSession({
        port: ctx.port,
        allowlistPath: ctx.allowlistPath,
        entry,
        terminalSessionId,
      });
      expect((response as { type: string }).type).toBe("terminal_error");
      expect((response as { message?: string }).message).toBe("Terminal session is not running");
      ws.terminate();

      const targets = await readFakeSshTargets(fakeSsh.logPath);
      expect(targets).toContain("missing-host.invalid");
      expect(targets).not.toContain("global.invalid");
    } finally {
      await killLocalTmuxSession(terminalSessionId);
      await ctx.cleanup();
      await fakeSsh.cleanup();
    }
  }, 30_000);

  it("rehydrates version 2 terminal destinations from persisted bubbles after provider restart", async () => {
    if (!(await ensureTmuxAvailable())) {
      console.warn("Skipping terminal routing restart test: tmux not found");
      return;
    }

    const fakeSsh = await setupFakeSshProxy();
    const entry = createAllowlistEntry({
      deviceId: randomUUID(),
      isAdmin: false,
      tokenDelivered: true,
    });
    const ctx = await setupTestServer([entry], {
      terminalTmux: { mode: "ssh", sshTarget: "global.invalid" },
    });
    const terminalSessionId = `term_restart_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    let restartedServer: ProviderServer | null = null;

    try {
      const descriptor = {
        terminalSessionId,
        title: "mike@eezo",
        version: 2,
        destination: { address: "mike@eezo" },
      };
      const base64 = Buffer.from(JSON.stringify(descriptor), "utf8").toString("base64");
      await ctx.server.sendMessage({
        target: entry.userId,
        text: "terminal",
        attachments: [
          {
            data: base64,
            mimeType: "application/vnd.clawline.terminal-session+json",
          },
        ],
      });

      await ctx.server.stop();

      restartedServer = await createProviderServer({
        config: {
          port: 0,
          statePath: path.dirname(ctx.allowlistPath),
          media: {
            storagePath: ctx.mediaPath,
            maxInlineBytes: 256_000,
            maxUploadBytes: 8_000_000,
            unreferencedUploadTtlSeconds: 86_400,
          },
          alertInstructionsPath: ctx.alertInstructionsPath,
          webRootPath: ctx.webRootPath,
          terminal: {
            tmux: {
              mode: "ssh",
              ssh: {
                target: "global.invalid",
              },
            },
          },
        },
        openClawConfig: testOpenClawConfig,
        replyResolver: testReplyResolver,
        logger: silentLogger,
        sessionStorePath: ctx.sessionStorePath,
      });
      await restartedServer.start();

      const { ws, response } = await authenticateTerminalSession({
        port: restartedServer.getPort(),
        allowlistPath: ctx.allowlistPath,
        entry,
        terminalSessionId,
      });
      expect((response as { type: string }).type).toBe("terminal_ready");
      ws.terminate();

      const targets = await readFakeSshTargets(fakeSsh.logPath);
      expect(targets).toContain("mike@eezo");
      expect(targets).not.toContain("global.invalid");
    } finally {
      await killLocalTmuxSession(terminalSessionId);
      if (restartedServer) {
        await restartedServer.stop();
      }
      await ctx.cleanup();
      await fakeSsh.cleanup();
    }
  }, 30_000);
});
