import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { createSurfAceManager } from "./surf-ace.js";

const TRUST_STORE_FILE = "surf-ace-trust.json";
const SCREEN_STATE_FILE = "surf-ace-screens.json";

type MockSurfaceHandle = {
  host: string;
  port: number;
  pairPayloads: Array<Record<string, unknown>>;
  snapshotPayloads: Array<Record<string, unknown>>;
  clientCloseCodes: number[];
  close: () => Promise<void>;
  emitEvent: (op: string, payload: Record<string, unknown>) => void;
};

type MockSurfaceOptions = {
  name?: string;
  surfaceId?: string;
  width?: number;
  height?: number;
  scale?: number;
  suppressHeartbeatPongs?: number;
  maxMessageBytes?: number;
  ignorePairResponses?: boolean;
};

async function waitFor(
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 25;
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function decodeRawData(data: WebSocket.RawData): string {
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
}

async function createMockSurface(options: MockSurfaceOptions = {}): Promise<MockSurfaceHandle> {
  const host = "127.0.0.1";
  const wss = new WebSocketServer({ port: 0, host, path: "/ws" });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", () => resolve());
    wss.once("error", (error) => reject(error));
  });
  const address = wss.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to resolve ws server address");
  }

  const pairPayloads: Array<Record<string, unknown>> = [];
  const snapshotPayloads: Array<Record<string, unknown>> = [];
  const clientCloseCodes: number[] = [];
  const clients = new Set<WebSocket>();
  const surfaceName = options.name ?? "Kitchen Display";
  const surfaceId = options.surfaceId ?? "a1b2c3d4";
  const width = options.width ?? 1920;
  const height = options.height ?? 1080;
  const scale = options.scale ?? 2;
  let suppressHeartbeatPongs = options.suppressHeartbeatPongs ?? 0;
  const maxMessageBytes = options.maxMessageBytes ?? 12 * 1024 * 1024;
  const ignorePairResponses = options.ignorePairResponses ?? false;

  let currentFrameId: string | null = null;
  let currentRevision = 0;
  let currentContentType: string | null = null;
  let currentTitle: string | null = null;
  let currentVisibleText = "";

  wss.on("connection", (socket) => {
    clients.add(socket);
    socket.on("close", (code) => {
      clients.delete(socket);
      clientCloseCodes.push(code);
    });
    socket.on("message", (raw) => {
      const parsed = JSON.parse(decodeRawData(raw)) as {
        type?: string;
        op?: string;
        id?: string;
        payload?: Record<string, unknown>;
      };
      if (
        parsed.type !== "request" ||
        typeof parsed.op !== "string" ||
        typeof parsed.id !== "string"
      ) {
        return;
      }

      const sendResponse = (body: Record<string, unknown>) => {
        socket.send(
          JSON.stringify({
            v: 1,
            type: "response",
            op: parsed.op,
            id: parsed.id,
            sentAt: Date.now(),
            ...body,
          }),
        );
      };

      if (parsed.op === "pair.request") {
        pairPayloads.push(parsed.payload ?? {});
        if (ignorePairResponses) {
          return;
        }
        sendResponse({
          ok: true,
          payload: {
            sessionId: `sa_${pairPayloads.length}`,
            resumed: pairPayloads.length > 1,
            surfaceId,
            surfaceName,
            viewport: { width, height, scale },
            capabilities: {
              contentTypes: ["html", "image", "pdf", "terminal", "markdown"],
              eventTypes: [
                "event.drawing_flush",
                "event.tap",
                "event.selection",
                "event.page",
                "event.snapshot_hint",
              ],
            },
            eventConfig: {
              profile: "minimum_deep",
              activeEvents: [
                "event.drawing_flush",
                "event.tap",
                "event.selection",
                "event.page",
                "event.snapshot_hint",
              ],
              drawingFlushConfig: { idleWindowMs: 8000, maxIntervalMs: 30000 },
            },
            limits: {
              maxMessageBytes,
              maxFrameBytes: 10 * 1024 * 1024,
              maxVisibleTextBytes: 4096,
              maxStrokePointsPerFlush: 8192,
              maxDrawingFlushBytes: 2 * 1024 * 1024,
            },
            state: {
              currentFrameId,
              currentRevision,
              contentType: currentContentType,
            },
          },
        });
        return;
      }

      if (parsed.op === "frame.set") {
        const payload = parsed.payload ?? {};
        currentFrameId = typeof payload.frameId === "string" ? payload.frameId : currentFrameId;
        const revision = payload.revision;
        currentRevision = typeof revision === "number" ? revision : currentRevision + 1;
        currentContentType =
          typeof payload.contentType === "string" ? payload.contentType : currentContentType;

        const displayRaw = payload.display;
        if (displayRaw && typeof displayRaw === "object" && !Array.isArray(displayRaw)) {
          const display = displayRaw as Record<string, unknown>;
          currentTitle = typeof display.title === "string" ? display.title : currentTitle;
        }

        const contentRaw = payload.content;
        if (contentRaw && typeof contentRaw === "object" && !Array.isArray(contentRaw)) {
          const content = contentRaw as Record<string, unknown>;
          const html = typeof content.html === "string" ? content.html : "";
          const markdown = typeof content.markdown === "string" ? content.markdown : "";
          currentVisibleText = html || markdown || currentVisibleText;
        }

        sendResponse({
          ok: true,
          payload: {
            currentFrameId,
            currentRevision,
            contentType: currentContentType,
          },
        });
        return;
      }

      if (parsed.op === "frame.clear") {
        const payload = parsed.payload ?? {};
        const revision = payload.revision;
        currentRevision = typeof revision === "number" ? revision : currentRevision + 1;
        currentFrameId = null;
        currentContentType = null;
        currentTitle = null;
        currentVisibleText = "";
        sendResponse({
          ok: true,
          payload: {
            currentFrameId,
            currentRevision,
            contentType: currentContentType,
          },
        });
        return;
      }

      if (parsed.op === "snapshot.get") {
        snapshotPayloads.push(parsed.payload ?? {});
        sendResponse({
          ok: true,
          payload: {
            frameId: currentFrameId,
            revision: currentRevision,
            contentType: currentContentType,
            title: currentTitle,
            viewport: {
              scrollOffset: { x: 0, y: 0 },
              visibleRect: { x: 0, y: 0, width, height },
              contentSize: { width, height },
              zoomLevel: 1,
            },
            visibleText: currentVisibleText,
            selection: null,
            drawings: [],
          },
        });
        return;
      }

      if (parsed.op === "annotations.remove") {
        sendResponse({
          ok: true,
          payload: {
            frameId: currentFrameId,
            removedStrokeIds: (parsed.payload?.strokeIds as unknown[]) ?? [],
            notFoundStrokeIds: [],
            remainingStrokeCount: 0,
          },
        });
        return;
      }

      if (parsed.op === "heartbeat.ping") {
        if (suppressHeartbeatPongs > 0) {
          suppressHeartbeatPongs -= 1;
          return;
        }
        sendResponse({ ok: true, payload: { nonce: parsed.payload?.nonce } });
      }
    });
  });

  return {
    host,
    port: address.port,
    pairPayloads,
    snapshotPayloads,
    clientCloseCodes,
    emitEvent: (op, payload) => {
      const body = JSON.stringify({
        v: 1,
        type: "event",
        op,
        eventId: `ev_${Date.now()}`,
        sentAt: Date.now(),
        payload,
      });
      for (const client of clients) {
        if (client.readyState === client.OPEN) {
          client.send(body);
        }
      }
    },
    close: async () => {
      for (const client of clients) {
        try {
          client.close();
        } catch {
          // ignore
        }
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Surf Ace manager (WebSocket transport)", () => {
  it("handles pair/push/snapshot/watch flows over WS", async () => {
    const statePath = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-test-"));
    const surface = await createMockSurface({
      name: "Kitchen Display",
      surfaceId: "a1b2c3d4",
      width: 1920,
      height: 1080,
      scale: 2,
    });

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      if (url === "http://localhost:18800/alert") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const manager = createSurfAceManager({
      statePath,
      fetchImpl,
      discoverImpl: async () => [
        {
          instanceName: "Kitchen Display",
          host: surface.host,
          port: surface.port,
          txt: {
            name: "Kitchen Display",
            v: "1",
            w: "1920",
            h: "1080",
            s: "2",
            cap: "31",
            busy: "0",
            pk: "a1b2c3d4",
            ws: "/ws",
            tls: "0",
          },
        },
      ],
      discoveryIntervalMs: 60_000,
      discoveryTimeoutMs: 100,
      wsHeartbeatIntervalMs: 1_000,
      wsHeartbeatTimeoutMs: 1_000,
      wsReconnectBackoffMs: [250],
    });

    await manager.start();

    const pairResult = await manager.pair({ userId: "flynn", screen: "Kitchen Display" });
    expect(pairResult.status).toBe("paired");

    const pushResult = await manager.push({
      userId: "flynn",
      screen: "Kitchen Display",
      contentType: "html",
      title: "Build Output",
      content: { html: "<html><body>Build Output</body></html>" },
      sourceRef: {
        sessionKey: "agent:main:clawline:flynn:main",
        messageId: "s_123",
      },
    });
    expect(pushResult.ok).toBe(true);

    const snapshot = await manager.snapshot({ userId: "flynn", screen: "Kitchen Display" });
    expect(snapshot.status).toBe("snapshot");
    expect(surface.snapshotPayloads[0]).toMatchObject({
      includeVisibleText: true,
      includeDrawings: false,
    });

    const watchResult = await manager.watch({
      userId: "flynn",
      screen: "Kitchen Display",
      enabled: true,
      watcherSessionKey: "agent:main:clawline:flynn:main",
    });
    expect(watchResult.enabled).toBe(true);

    surface.emitEvent("event.tap", {
      frameId: pushResult.frameId,
      revision: 1,
      kind: "tap",
      position: { x: 10, y: 20 },
    });

    await waitFor(() => fetchImpl.mock.calls.length > 0);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:18800/alert",
      expect.objectContaining({ method: "POST" }),
    );

    const context = await manager.buildContextInjection({ userId: "flynn" });
    expect(context).toContain("## Surf Ace Screens");
    expect(context).toContain("Kitchen Display");
    expect(context).toContain("sourceRef: agent:main:clawline:flynn:main#s_123");

    await manager.stop();
    await surface.close();
    await fs.rm(statePath, { recursive: true, force: true });
  });

  it("strips WKWebView CSS noise prefix from snapshot visibleText", async () => {
    const statePath = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-test-"));
    const surface = await createMockSurface({
      name: "Noise Surface",
      surfaceId: "aa11bb22",
      width: 1024,
      height: 768,
      scale: 2,
    });

    const manager = createSurfAceManager({
      statePath,
      discoverImpl: async () => [
        {
          instanceName: "Noise Surface",
          host: surface.host,
          port: surface.port,
          txt: {
            name: "Noise Surface",
            v: "1",
            w: "1024",
            h: "768",
            s: "2",
            cap: "31",
            busy: "0",
            pk: "aa11bb22",
            ws: "/ws",
            tls: "0",
          },
        },
      ],
      discoveryIntervalMs: 60_000,
      discoveryTimeoutMs: 100,
    });

    const noisyText =
      "p.p1 {margin: 0.0px 0.0px 0.0px 0.0px} span.s1 {font-family: 'Helvetica'} ACTUAL_CONTENT_HERE";

    await manager.start();
    await manager.pair({ userId: "flynn", screen: "Noise Surface" });
    await manager.push({
      userId: "flynn",
      screen: "Noise Surface",
      contentType: "html",
      content: { html: noisyText },
      title: "Noisy",
    });

    const snapshot = await manager.snapshot({ userId: "flynn", screen: "Noise Surface" });
    expect(snapshot.status).toBe("snapshot");
    if (snapshot.status !== "snapshot") {
      throw new Error("snapshot expected");
    }
    expect(snapshot.snapshot.visibleText).toBe("ACTUAL_CONTENT_HERE");

    await manager.stop();
    await surface.close();
    await fs.rm(statePath, { recursive: true, force: true });
  });

  it("allows explicit pair when discovery marks the screen busy", async () => {
    const statePath = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-test-"));
    const surface = await createMockSurface({
      name: "Surf Ace - iPad",
      surfaceId: "23c71e1c",
      width: 1194,
      height: 834,
      scale: 2,
    });

    const manager = createSurfAceManager({
      statePath,
      discoverImpl: async () => [
        {
          instanceName: "Surf Ace - iPad",
          host: surface.host,
          port: surface.port,
          txt: {
            name: "Surf Ace - iPad",
            v: "1",
            w: "1194",
            h: "834",
            s: "2",
            cap: "31",
            busy: "1",
            pk: "23c71e1c",
            ws: "/ws",
            tls: "0",
          },
        },
      ],
      discoveryIntervalMs: 60_000,
      discoveryTimeoutMs: 100,
      wsHeartbeatIntervalMs: 1_000,
      wsHeartbeatTimeoutMs: 1_000,
      wsReconnectBackoffMs: [250],
    });

    await manager.start();
    const pairResult = await manager.pair({ userId: "flynn", screen: "Surf Ace - iPad" });
    expect(pairResult.status).toBe("paired");
    expect(pairResult.screen.sessionToken).toBeTruthy();

    await manager.stop();
    await surface.close();
    await fs.rm(statePath, { recursive: true, force: true });
  });

  it("auto-pairs trusted screens over WS even when discovery marks busy", async () => {
    const statePath = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-test-"));
    await fs.writeFile(
      path.join(statePath, TRUST_STORE_FILE),
      JSON.stringify(
        {
          version: 1,
          entries: [
            {
              fingerprint: "23c71e1c",
              displayName: "Surf Ace - iPad",
              trustedAt: 1,
            },
          ],
        },
        null,
        2,
      ),
    );

    const surface = await createMockSurface({
      name: "Surf Ace - iPad",
      surfaceId: "23c71e1c",
      width: 1194,
      height: 834,
      scale: 2,
    });

    const manager = createSurfAceManager({
      statePath,
      discoverImpl: async () => [
        {
          instanceName: "Surf Ace - iPad",
          host: surface.host,
          port: surface.port,
          txt: {
            name: "Surf Ace - iPad",
            v: "1",
            w: "1194",
            h: "834",
            s: "2",
            cap: "31",
            busy: "1",
            pk: "23c71e1c",
            ws: "/ws",
            tls: "0",
          },
        },
      ],
      discoveryIntervalMs: 60_000,
      discoveryTimeoutMs: 100,
      wsHeartbeatIntervalMs: 1_000,
      wsHeartbeatTimeoutMs: 1_000,
      wsReconnectBackoffMs: [250],
    });

    await manager.start();

    await waitFor(() => surface.pairPayloads.length > 0);
    const screens = manager.listScreens();
    expect(screens).toContainEqual(
      expect.objectContaining({
        id: "23c71e1c",
        sessionToken: expect.any(String),
      }),
    );

    await manager.stop();
    await surface.close();
    await fs.rm(statePath, { recursive: true, force: true });
  });

  it("does not throw context injection when paired snapshot fails", async () => {
    const statePath = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-test-"));
    const surface = await createMockSurface({ name: "Offline Screen", surfaceId: "deadbeef" });

    const manager = createSurfAceManager({
      statePath,
      discoverImpl: async () => [
        {
          instanceName: "Offline Screen",
          host: surface.host,
          port: surface.port,
          txt: {
            name: "Offline Screen",
            v: "1",
            w: "1194",
            h: "834",
            s: "2",
            cap: "31",
            busy: "0",
            pk: "deadbeef",
            ws: "/ws",
            tls: "0",
          },
        },
      ],
      discoveryIntervalMs: 60_000,
      discoveryTimeoutMs: 100,
      wsHeartbeatIntervalMs: 1_000,
      wsHeartbeatTimeoutMs: 1_000,
      wsReconnectBackoffMs: [250],
    });

    await manager.start();
    await manager.pair({ userId: "flynn", screen: "Offline Screen" });
    await surface.close();

    const context = await manager.buildContextInjection({ userId: "flynn" });
    expect(context).toContain("## Surf Ace Screens");
    expect(context).toContain("Offline Screen");
    expect(context).toContain("paired): unreachable");

    await manager.stop();
    await fs.rm(statePath, { recursive: true, force: true });
  });

  it("reconnects with takeover after missed heartbeat window", async () => {
    const statePath = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-test-"));
    const surface = await createMockSurface({
      name: "Heartbeat Surface",
      surfaceId: "f1e2d3c4",
      suppressHeartbeatPongs: 2,
    });

    const manager = createSurfAceManager({
      statePath,
      discoverImpl: async () => [
        {
          instanceName: "Heartbeat Surface",
          host: surface.host,
          port: surface.port,
          txt: {
            name: "Heartbeat Surface",
            v: "1",
            w: "1024",
            h: "768",
            s: "2",
            cap: "31",
            busy: "0",
            pk: "f1e2d3c4",
            ws: "/ws",
            tls: "0",
          },
        },
      ],
      discoveryIntervalMs: 60_000,
      discoveryTimeoutMs: 100,
      wsHeartbeatIntervalMs: 250,
      wsHeartbeatTimeoutMs: 250,
      wsReconnectBackoffMs: [250],
    });

    await manager.start();
    await manager.pair({ userId: "flynn", screen: "Heartbeat Surface" });

    await waitFor(() => surface.pairPayloads.length >= 2, { timeoutMs: 10_000 });

    const takeoverPair = surface.pairPayloads.find((payload, index) => {
      if (index === 0) {
        return false;
      }
      return payload.takeover === true;
    });
    expect(takeoverPair).toBeTruthy();

    await manager.stop();
    await surface.close();
    await fs.rm(statePath, { recursive: true, force: true });
  });

  it("closes with 4413 when incoming event exceeds negotiated maxMessageBytes", async () => {
    const statePath = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-test-"));
    const surface = await createMockSurface({
      name: "Limit Surface",
      surfaceId: "beadfeed",
      maxMessageBytes: 256,
    });

    const manager = createSurfAceManager({
      statePath,
      discoverImpl: async () => [
        {
          instanceName: "Limit Surface",
          host: surface.host,
          port: surface.port,
          txt: {
            name: "Limit Surface",
            v: "1",
            w: "1024",
            h: "768",
            s: "2",
            cap: "31",
            busy: "0",
            pk: "beadfeed",
            ws: "/ws",
            tls: "0",
          },
        },
      ],
      discoveryIntervalMs: 60_000,
      discoveryTimeoutMs: 100,
    });

    await manager.start();
    await manager.pair({ userId: "flynn", screen: "Limit Surface" });
    surface.emitEvent("event.tap", {
      frameId: "fr_deadbeef",
      revision: 1,
      kind: "tap",
      position: { x: 10, y: 20 },
      nearestContent: "x".repeat(2_000),
    });

    await waitFor(() => surface.clientCloseCodes.includes(4413));

    await manager.stop();
    await surface.close();
    await fs.rm(statePath, { recursive: true, force: true });
  });

  it("registers manual WS URLs without requiring identity endpoint", async () => {
    const statePath = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-test-"));
    const manager = createSurfAceManager({
      statePath,
      discoverImpl: async () => [],
      fetchImpl: async () => new Response("not found", { status: 404 }),
      discoveryIntervalMs: 60_000,
      discoveryTimeoutMs: 100,
    });

    await manager.start();
    const result = await manager.register({ userId: "flynn", url: "ws://192.168.50.25:8765/ws" });

    expect(result.ok).toBe(true);
    expect(result.screen).toMatchObject({
      host: "192.168.50.25",
      port: 8765,
      intake: "manual",
      status: "discovered",
      sessionToken: null,
    });

    await manager.stop();
    await fs.rm(statePath, { recursive: true, force: true });
  });

  it("rejects TLS registration URLs in ws-only v1 mode", async () => {
    const statePath = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-test-"));
    const manager = createSurfAceManager({
      statePath,
      discoverImpl: async () => [],
      discoveryIntervalMs: 60_000,
      discoveryTimeoutMs: 100,
    });

    await manager.start();
    await expect(
      manager.register({ userId: "flynn", url: "https://192.168.50.25:8765" }),
    ).rejects.toThrow("Surf Ace register URL must use http:// or ws://");

    await manager.stop();
    await fs.rm(statePath, { recursive: true, force: true });
  });

  it("clears legacy stored session IDs and omits resume on pair", async () => {
    const statePath = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-test-"));
    const surface = await createMockSurface({
      name: "Surf Ace - iPad",
      surfaceId: "23c71e1c",
      width: 1194,
      height: 834,
      scale: 2,
    });

    await fs.writeFile(
      path.join(statePath, SCREEN_STATE_FILE),
      JSON.stringify(
        {
          version: 2,
          providerId: "pv_testprovider",
          screens: [
            {
              fingerprint: "23c71e1c",
              host: surface.host,
              port: surface.port,
              name: "Surf Ace - iPad",
              intake: "manual",
              wsPath: "/ws",
              wsSecure: false,
              protocolVersion: 1,
              width: 1194,
              height: 834,
              scale: 2,
              contentTypes: 31,
              sessionToken: "legacy_rest_token",
              watchEnabled: false,
            },
          ],
        },
        null,
        2,
      ),
    );

    const manager = createSurfAceManager({
      statePath,
      discoverImpl: async () => [],
      discoveryIntervalMs: 60_000,
      discoveryTimeoutMs: 100,
    });

    await manager.start();

    const persistedAfterStart = JSON.parse(
      await fs.readFile(path.join(statePath, SCREEN_STATE_FILE), "utf8"),
    ) as {
      screens?: Array<{ fingerprint?: string; sessionToken?: unknown }>;
    };
    const persistedScreen = persistedAfterStart.screens?.find(
      (entry) => entry.fingerprint === "23c71e1c",
    );
    expect(persistedScreen?.sessionToken ?? null).toBeNull();

    await manager.pair({ userId: "flynn", screen: "23c71e1c" });
    expect(surface.pairPayloads[0]).not.toHaveProperty("resume");

    await manager.stop();
    await surface.close();
    await fs.rm(statePath, { recursive: true, force: true });
  });
});
