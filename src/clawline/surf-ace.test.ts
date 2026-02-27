import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSurfAceManager } from "./surf-ace.js";

describe("Surf Ace manager", () => {
  it("handles pair/push/snapshot/watch flows for discovered screens", async () => {
    const statePath = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-test-"));
    const discoverImpl = vi.fn(async () => [
      {
        instanceName: "Kitchen Display",
        host: "10.0.0.10",
        port: 17777,
        txt: {
          name: "Kitchen Display",
          v: "1",
          w: "1920",
          h: "1080",
          s: "2",
          cap: "31",
          busy: "0",
          pk: "a1b2c3d4",
        },
      },
    ]);

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      const pathname = new URL(url).pathname;
      const bodyText = typeof init?.body === "string" ? init.body : "";

      if (pathname === "/pair") {
        return new Response(JSON.stringify({ status: "ok", sessionToken: "tok_123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (pathname === "/frame") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (pathname === "/snapshot") {
        return new Response(
          JSON.stringify({
            frameId: "fr_1",
            contentType: "html",
            title: "Build Output",
            visibleText: "Error: connection refused on port 8080",
            selection: { kind: "text", text: "connection refused" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (pathname === "/watch" || pathname === "/unwatch") {
        return new Response("", { status: 200 });
      }
      if (url === "http://localhost:18800/alert") {
        const parsed = bodyText ? (JSON.parse(bodyText) as { sessionKey?: string }) : {};
        expect(parsed.sessionKey).toBe("agent:main:clawline:flynn:main");
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      return new Response("not found", { status: 404 });
    });

    const manager = createSurfAceManager({
      statePath,
      discoverImpl,
      fetchImpl,
      discoveryIntervalMs: 60_000,
      discoveryTimeoutMs: 100,
    });

    await manager.start();
    manager.setCallbackBaseUrl("http://tars.local:18800");

    // Auto-pair — no PIN
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

    const snap = await manager.snapshot({ userId: "flynn", screen: "Kitchen Display" });
    expect(snap.status).toBe("snapshot");

    const watchResult = await manager.watch({
      userId: "flynn",
      screen: "Kitchen Display",
      enabled: true,
      debounce: { scroll_settle: 500 },
      watcherSessionKey: "agent:main:clawline:flynn:main",
    });
    expect(watchResult.enabled).toBe(true);

    const eventResult = manager.handleInboundEvent({
      screenId: "a1b2c3d4",
      payload: { event: "text_selected", text: "hello" },
      remoteAddress: "10.0.0.10",
    });
    expect(eventResult.statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:18800/alert",
      expect.objectContaining({ method: "POST" }),
    );

    const context = await manager.buildContextInjection({ userId: "flynn" });
    expect(context).toContain("## Surf Ace Screens");
    expect(context).toContain("Kitchen Display");
    expect(context).toContain("sourceRef: agent:main:clawline:flynn:main#s_123");

    await manager.clear({ userId: "flynn", screen: "Kitchen Display" });
    const pushAfterClear = await manager.push({
      userId: "flynn",
      screen: "Kitchen Display",
      contentType: "html",
      content: { html: "<html><body>After Clear</body></html>" },
      title: "After Clear",
    });
    expect(pushAfterClear.ok).toBe(true);

    await manager.stop();
    await fs.rm(statePath, { recursive: true, force: true });
    expect(fetchImpl).toHaveBeenCalled();
    expect(discoverImpl).toHaveBeenCalled();
  });

  it("rejects inbound events from mismatched source addresses", async () => {
    const statePath = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-test-"));
    const manager = createSurfAceManager({
      statePath,
      discoveryIntervalMs: 60_000,
      discoverImpl: async () => [
        {
          instanceName: "Office",
          host: "10.0.0.20",
          port: 17777,
          txt: { name: "Office", busy: "0", pk: "d4c3b2a1" },
        },
      ],
      fetchImpl: async () =>
        new Response(JSON.stringify({ status: "ok", sessionToken: "tok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    await manager.start();
    await manager.pair({ userId: "flynn", screen: "Office" });
    manager.setCallbackBaseUrl("http://127.0.0.1:18800");
    await manager.watch({ userId: "flynn", screen: "Office", enabled: true });

    const result = manager.handleInboundEvent({
      screenId: "d4c3b2a1",
      payload: { event: "point" },
      remoteAddress: "10.0.0.99",
    });

    expect(result.statusCode).toBe(403);
    await manager.stop();
    await fs.rm(statePath, { recursive: true, force: true });
  });
});
