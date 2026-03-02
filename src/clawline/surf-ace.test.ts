import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { createSurfAceManager } from "./surf-ace.js";

const SCREEN_STATE_FILE = "surf-ace-screens.json";

type MockSurfaceHandle = {
  host: string;
  port: number;
  pairPayloads: Array<Record<string, unknown>>;
  snapshotPayloads: Array<Record<string, unknown>>;
  receivedOps: string[];
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
  wireMode?: "content" | "frame";
  suppressHeartbeatPongs?: number;
  maxMessageBytes?: number;
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
  const receivedOps: string[] = [];
  const clientCloseCodes: number[] = [];
  const clients = new Set<WebSocket>();
  const surfaceName = options.name ?? "Kitchen Display";
  const surfaceId = options.surfaceId ?? "a1b2c3d4";
  const width = options.width ?? 1920;
  const height = options.height ?? 1080;
  const scale = options.scale ?? 2;
  const wireMode = options.wireMode ?? "content";
  let suppressHeartbeatPongs = options.suppressHeartbeatPongs ?? 0;
  const maxMessageBytes = options.maxMessageBytes ?? 12 * 1024 * 1024;

  let currentContentId: string | null = null;
  let currentRevision = 0;
  let currentContentType: string | null = null;
  let currentVisibleText = "";
  let annotations: Array<Record<string, unknown>> = [];
  let eventSeq = 0;

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

      receivedOps.push(parsed.op);

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
        sendResponse({
          ok: true,
          payload: {
            sessionId: `sa_${pairPayloads.length}`,
            resumed: pairPayloads.length > 1,
            surfaceId,
            surfaceName,
            viewport: { width, height, scale },
            capabilities: {
              contentTypes: ["html", "image", "pdf", "terminal", "markdown", "video", "canvas"],
              eventTypes: [
                "event.drawing_flush",
                "event.tap",
                "event.selection",
                "event.page",
                "event.snapshot_hint",
                "event.scroll",
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
              ...(wireMode === "frame"
                ? { currentFrameId: currentContentId }
                : { currentContentId }),
              currentRevision,
              contentType: currentContentType,
            },
          },
        });
        return;
      }

      if (parsed.op === "content.set" && wireMode === "content") {
        const payload = parsed.payload ?? {};
        currentContentId =
          typeof payload.contentId === "string" ? payload.contentId : currentContentId;
        const revision = payload.revision;
        currentRevision = typeof revision === "number" ? revision : currentRevision + 1;
        currentContentType =
          typeof payload.contentType === "string" ? payload.contentType : currentContentType;
        annotations = [];

        const contentRaw = payload.content;
        if (contentRaw && typeof contentRaw === "object" && !Array.isArray(contentRaw)) {
          const content = contentRaw as Record<string, unknown>;
          if (typeof content.html === "string") {
            currentVisibleText = content.html;
          } else if (typeof content.markdown === "string") {
            currentVisibleText = content.markdown;
          }
        }

        sendResponse({
          ok: true,
          payload: {
            currentContentId,
            currentRevision,
            contentType: currentContentType,
          },
        });
        return;
      }

      if (parsed.op === "content.clear" && wireMode === "content") {
        const payload = parsed.payload ?? {};
        const revision = payload.revision;
        currentRevision = typeof revision === "number" ? revision : currentRevision + 1;
        currentContentId = null;
        currentContentType = null;
        currentVisibleText = "";
        annotations = [];
        sendResponse({
          ok: true,
          payload: {
            currentContentId,
            currentRevision,
            contentType: currentContentType,
          },
        });
        return;
      }

      if (parsed.op === "frame.set" && wireMode === "frame") {
        const payload = parsed.payload ?? {};
        currentContentId = typeof payload.frameId === "string" ? payload.frameId : currentContentId;
        const revision = payload.revision;
        currentRevision = typeof revision === "number" ? revision : currentRevision + 1;
        currentContentType =
          typeof payload.contentType === "string" ? payload.contentType : currentContentType;
        annotations = [];

        const contentRaw = payload.content;
        if (contentRaw && typeof contentRaw === "object" && !Array.isArray(contentRaw)) {
          const content = contentRaw as Record<string, unknown>;
          if (typeof content.html === "string") {
            currentVisibleText = content.html;
          } else if (typeof content.markdown === "string") {
            currentVisibleText = content.markdown;
          }
        }

        sendResponse({
          ok: true,
          payload: {
            currentFrameId: currentContentId,
            currentRevision,
            contentType: currentContentType,
          },
        });
        return;
      }

      if (parsed.op === "frame.clear" && wireMode === "frame") {
        const payload = parsed.payload ?? {};
        const revision = payload.revision;
        currentRevision = typeof revision === "number" ? revision : currentRevision + 1;
        currentContentId = null;
        currentContentType = null;
        currentVisibleText = "";
        annotations = [];
        sendResponse({
          ok: true,
          payload: {
            currentFrameId: currentContentId,
            currentRevision,
            contentType: currentContentType,
          },
        });
        return;
      }

      if (parsed.op === "snapshot.get") {
        snapshotPayloads.push(parsed.payload ?? {});
        const includeDrawings = parsed.payload?.includeDrawings === true;
        sendResponse({
          ok: true,
          payload: {
            ...(wireMode === "frame"
              ? { frameId: currentContentId }
              : { contentId: currentContentId }),
            revision: currentRevision,
            contentType: currentContentType,
            viewport: {
              scrollOffset: { x: 0, y: 0 },
              visibleRect: { x: 0, y: 0, width, height },
              contentSize: { width, height },
              zoomLevel: 1,
            },
            visibleText: currentVisibleText,
            selection: null,
            drawings: includeDrawings ? annotations : undefined,
          },
        });
        return;
      }

      if (parsed.op === "annotations.remove") {
        const contentId =
          wireMode === "frame"
            ? typeof parsed.payload?.frameId === "string"
              ? parsed.payload.frameId
              : ""
            : typeof parsed.payload?.contentId === "string"
              ? parsed.payload.contentId
              : "";
        if (!currentContentId || contentId !== currentContentId) {
          sendResponse({
            ok: false,
            error: {
              code: "stale_content",
              message: "content mismatch",
            },
          });
          return;
        }
        const strokeIds = Array.isArray(parsed.payload?.strokeIds)
          ? parsed.payload.strokeIds.filter((entry): entry is string => typeof entry === "string")
          : [];
        const currentById = new Map(
          annotations
            .filter((entry) => typeof entry.strokeId === "string")
            .map((entry) => [entry.strokeId as string, entry]),
        );
        const removedStrokeIds: string[] = [];
        const notFoundStrokeIds: string[] = [];
        for (const strokeId of strokeIds) {
          if (currentById.has(strokeId)) {
            currentById.delete(strokeId);
            removedStrokeIds.push(strokeId);
          } else {
            notFoundStrokeIds.push(strokeId);
          }
        }
        annotations = Array.from(currentById.values());
        sendResponse({
          ok: true,
          payload: {
            ...(wireMode === "frame"
              ? { frameId: currentContentId }
              : { contentId: currentContentId }),
            removedStrokeIds,
            notFoundStrokeIds,
            remainingStrokeCount: annotations.length,
          },
        });
        return;
      }

      if (
        (parsed.op === "content.set" ||
          parsed.op === "content.clear" ||
          parsed.op === "frame.set" ||
          parsed.op === "frame.clear") &&
        ((wireMode === "frame" && parsed.op.startsWith("content.")) ||
          (wireMode === "content" && parsed.op.startsWith("frame.")))
      ) {
        sendResponse({
          ok: false,
          error: {
            code: "invalid_payload",
            message: "Unknown operation.",
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
    receivedOps,
    clientCloseCodes,
    emitEvent: (op, payload) => {
      if (op === "event.drawing_flush") {
        const strokes = Array.isArray(payload.strokes)
          ? payload.strokes.filter(
              (entry): entry is Record<string, unknown> =>
                Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
            )
          : [];
        for (const stroke of strokes) {
          const strokeId = typeof stroke.strokeId === "string" ? stroke.strokeId : "";
          if (!strokeId) {
            continue;
          }
          const withoutExisting = annotations.filter((item) => item.strokeId !== strokeId);
          annotations = [...withoutExisting, stroke];
        }
      }

      const body = JSON.stringify({
        v: 1,
        type: "event",
        op,
        eventId: `ev_${Date.now()}_${eventSeq++}`,
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

describe("Surf Ace manager (connection daemon + local buffer)", () => {
  it("auto-connects discovered screens and reports list state", async () => {
    const statePath = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-test-"));
    const surface = await createMockSurface({ name: "Kitchen Display", surfaceId: "a1b2c3d4" });

    const manager = createSurfAceManager({
      statePath,
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
            cap: "127",
            busy: "0",
            pk: "a1b2c3d4",
            ws: "/ws",
            tls: "0",
          },
        },
      ],
      discoveryIntervalMs: 60_000,
      discoveryTimeoutMs: 100,
    });

    await manager.start();
    await waitFor(() => surface.pairPayloads.length > 0);

    const list = await manager.list({ userId: "flynn" });
    expect(list).toContainEqual(
      expect.objectContaining({
        fingerprint: "a1b2c3d4",
        name: "Kitchen Display",
        connectionState: "connected",
        viewport: expect.objectContaining({ width: 1920, height: 1080, scale: 2 }),
        activeContent: null,
        pendingEvents: 0,
      }),
    );

    await manager.stop();
    await surface.close();
    await fs.rm(statePath, { recursive: true, force: true });
  });

  it("pushes and clears using content operations", async () => {
    const statePath = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-test-"));
    const surface = await createMockSurface({ name: "Kitchen Display", surfaceId: "a1b2c3d4" });

    const manager = createSurfAceManager({
      statePath,
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
            cap: "127",
            busy: "0",
            pk: "a1b2c3d4",
            ws: "/ws",
            tls: "0",
          },
        },
      ],
      discoveryIntervalMs: 60_000,
      discoveryTimeoutMs: 100,
    });

    await manager.start();
    await waitFor(() => surface.pairPayloads.length > 0);

    const push = await manager.push({
      userId: "flynn",
      fingerprint: "a1b2c3d4",
      contentType: "html",
      content: "<html><body>Build Output</body></html>",
    });
    expect(push.contentId).toMatch(/^ct_/);
    expect(push.revision).toBe(1);

    await manager.clear({ userId: "flynn", fingerprint: "a1b2c3d4" });

    expect(surface.receivedOps).toContain("content.set");
    expect(surface.receivedOps).toContain("content.clear");
    expect(surface.receivedOps).not.toContain("frame.set");
    expect(surface.receivedOps).not.toContain("frame.clear");

    await manager.stop();
    await surface.close();
    await fs.rm(statePath, { recursive: true, force: true });
  });

  it("bridges content push to legacy frame operations", async () => {
    const statePath = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-test-"));
    const surface = await createMockSurface({
      name: "Legacy Surface",
      surfaceId: "6364d5a2",
      wireMode: "frame",
    });

    const manager = createSurfAceManager({
      statePath,
      discoverImpl: async () => [
        {
          instanceName: "Legacy Surface",
          host: surface.host,
          port: surface.port,
          txt: {
            name: "Legacy Surface",
            v: "1",
            w: "1920",
            h: "1080",
            s: "2",
            cap: "31",
            busy: "0",
            pk: "6364d5a2",
            ws: "/ws",
            tls: "0",
          },
        },
      ],
      discoveryIntervalMs: 60_000,
      discoveryTimeoutMs: 100,
    });

    await manager.start();
    await waitFor(() => surface.pairPayloads.length > 0);

    const push = await manager.push({
      userId: "flynn",
      fingerprint: "6364d5a2",
      contentType: "html",
      content: "<html><body>Legacy push</body></html>",
    });
    expect(push.contentId).toMatch(/^fr_/);
    expect(push.revision).toBe(1);

    const listAfterPush = await manager.list({ userId: "flynn" });
    expect(listAfterPush).toContainEqual(
      expect.objectContaining({
        fingerprint: "6364d5a2",
        activeContent: expect.objectContaining({
          contentId: push.contentId,
          contentType: "html",
          revision: 1,
        }),
      }),
    );

    await manager.clear({ userId: "flynn", fingerprint: "6364d5a2" });

    expect(surface.receivedOps).toContain("frame.set");
    expect(surface.receivedOps).toContain("frame.clear");
    expect(surface.receivedOps).not.toContain("content.set");

    await manager.stop();
    await surface.close();
    await fs.rm(statePath, { recursive: true, force: true });
  });

  it("reads local register buffer and fires one alert per dirty cycle", async () => {
    const statePath = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-test-"));
    const surface = await createMockSurface({ name: "Kitchen Display", surfaceId: "a1b2c3d4" });

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
            cap: "127",
            busy: "0",
            pk: "a1b2c3d4",
            ws: "/ws",
            tls: "0",
          },
        },
      ],
      discoveryIntervalMs: 60_000,
      discoveryTimeoutMs: 100,
    });

    await manager.start();
    await waitFor(() => surface.pairPayloads.length > 0);

    surface.emitEvent("event.tap", {
      contentId: "ct_1",
      revision: 1,
      kind: "tap",
      position: { x: 10, y: 20 },
      nearestContent: "Tap Text",
    });
    surface.emitEvent("event.page", {
      contentId: "ct_1",
      revision: 1,
      page: 3,
      totalPages: 10,
      pageText: "3/10",
    });

    await waitFor(() => fetchImpl.mock.calls.length >= 1);
    expect(fetchImpl.mock.calls.length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const firstRead = await manager.read({ userId: "flynn", fingerprint: "a1b2c3d4" });
    expect(firstRead.taps).toHaveLength(1);
    expect(firstRead.page).toEqual(
      expect.objectContaining({ pageNumber: 3, pageCount: 10, pageLabel: "3/10" }),
    );

    const secondRead = await manager.read({ userId: "flynn", fingerprint: "a1b2c3d4" });
    expect(secondRead.taps).toHaveLength(0);
    expect(secondRead.page).toBeNull();

    surface.emitEvent("event.tap", {
      contentId: "ct_1",
      revision: 2,
      kind: "tap",
      position: { x: 1, y: 2 },
      nearestContent: "Again",
    });

    await waitFor(() => fetchImpl.mock.calls.length >= 2);
    expect(fetchImpl.mock.calls.length).toBe(2);

    await manager.stop();
    await surface.close();
    await fs.rm(statePath, { recursive: true, force: true });
  });

  it("maintains persistent annotations and supports annotations.remove", async () => {
    const statePath = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-test-"));
    const surface = await createMockSurface({ name: "Kitchen Display", surfaceId: "a1b2c3d4" });

    const manager = createSurfAceManager({
      statePath,
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
            cap: "127",
            busy: "0",
            pk: "a1b2c3d4",
            ws: "/ws",
            tls: "0",
          },
        },
      ],
      discoveryIntervalMs: 60_000,
      discoveryTimeoutMs: 100,
    });

    await manager.start();
    await waitFor(() => surface.pairPayloads.length > 0);

    const push = await manager.push({
      userId: "flynn",
      fingerprint: "a1b2c3d4",
      contentType: "html",
      content: "<html>test</html>",
    });

    surface.emitEvent("event.drawing_flush", {
      contentId: push.contentId,
      revision: push.revision,
      flushId: "flush_1",
      flushReason: "idle_window",
      idleWindowMs: 8000,
      maxIntervalMs: 30000,
      strokes: [
        {
          strokeId: "stroke_1",
          tool: "pencil",
          points: [{ x: 1, y: 2, pressure: 0.5, timestamp: Date.now() }],
        },
        {
          strokeId: "stroke_2",
          tool: "pencil",
          points: [{ x: 3, y: 4, pressure: 0.5, timestamp: Date.now() }],
        },
      ],
      strokeCount: 2,
      pointsCount: 2,
      firstStrokeAt: Date.now(),
      lastStrokeAt: Date.now(),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    const beforeRemove = await manager.read({ userId: "flynn", fingerprint: "a1b2c3d4" });
    expect(beforeRemove.annotations).toHaveLength(2);

    const removed = await manager.annotationsRemove({
      userId: "flynn",
      fingerprint: "a1b2c3d4",
      contentId: push.contentId,
      strokeIds: ["stroke_1"],
    });
    expect(removed.removedStrokeIds).toEqual(["stroke_1"]);

    const afterRemove = await manager.read({ userId: "flynn", fingerprint: "a1b2c3d4" });
    expect(afterRemove.annotations).toHaveLength(1);
    expect(afterRemove.annotations[0]?.strokeId).toBe("stroke_2");

    await expect(
      manager.annotationsRemove({
        userId: "flynn",
        fingerprint: "a1b2c3d4",
        contentId: "ct_wrong",
        strokeIds: ["stroke_2"],
      }),
    ).rejects.toThrow("stale_content");

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
            cap: "127",
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
    await waitFor(() => surface.pairPayloads.length > 0);

    surface.emitEvent("event.tap", {
      contentId: "ct_deadbeef",
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
              intake: "bonjour",
              wsPath: "/ws",
              wsSecure: false,
              protocolVersion: 1,
              width: 1194,
              height: 834,
              scale: 2,
              contentTypes: 127,
              sessionToken: "legacy_rest_token",
              currentContentId: null,
              currentRevision: 0,
              currentContentType: null,
            },
          ],
        },
        null,
        2,
      ),
    );

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
            cap: "127",
            busy: "0",
            pk: "23c71e1c",
            ws: "/ws",
            tls: "0",
          },
        },
      ],
      discoveryIntervalMs: 60_000,
      discoveryTimeoutMs: 100,
    });

    await manager.start();
    await waitFor(() => surface.pairPayloads.length > 0);
    expect(surface.pairPayloads[0]).not.toHaveProperty("resume");

    await manager.stop();
    await surface.close();
    await fs.rm(statePath, { recursive: true, force: true });
  });
});
