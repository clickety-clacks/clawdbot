import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSurfAceManager } from "./surf-ace.js";

const SCREEN_STATE_FILE = "surf-ace-screens.json";
const TRUST_STORE_FILE = "surf-ace-trust.json";

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

  it("does not throw context injection when a paired screen snapshot fails", async () => {
    const statePath = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-test-"));
    const manager = createSurfAceManager({
      statePath,
      discoverImpl: async () => [
        {
          instanceName: "Offline Screen",
          host: "192.168.50.25",
          port: 8765,
          txt: {
            name: "Offline Screen",
            v: "1",
            w: "1194",
            h: "834",
            s: "2",
            cap: "31",
            busy: "0",
            pk: "deadbeef",
          },
        },
      ],
      fetchImpl: vi.fn(async (input: RequestInfo | URL) => {
        const url =
          input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
        const pathname = new URL(url).pathname;
        if (pathname === "/pair") {
          return new Response(JSON.stringify({ status: "ok", sessionToken: "tok_ctx" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (pathname === "/snapshot") {
          throw new Error("unreachable");
        }
        return new Response("not found", { status: 404 });
      }),
      discoveryIntervalMs: 60_000,
      discoveryTimeoutMs: 100,
    });

    await manager.start();
    await manager.pair({ userId: "flynn", screen: "Offline Screen" });

    const context = await manager.buildContextInjection({ userId: "flynn" });
    expect(context).toContain("## Surf Ace Screens");
    expect(context).toContain("Offline Screen");
    expect(context).toContain("paired): unreachable");

    await manager.stop();
    await fs.rm(statePath, { recursive: true, force: true });
  });

  it("registers a Surf Ace screen manually by URL for normal pair flow", async () => {
    const statePath = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-test-"));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      const pathname = new URL(url).pathname;
      if (pathname === "/identity") {
        return new Response(
          JSON.stringify({
            fingerprint: "b1c2d3e4",
            name: "Guest iPad",
            v: 1,
            w: 1194,
            h: 834,
            s: 2,
            cap: 31,
            busy: 0,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      if (pathname === "/pair") {
        return new Response(JSON.stringify({ status: "ok", sessionToken: "tok_manual" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const manager = createSurfAceManager({
      statePath,
      discoverImpl: async () => [],
      fetchImpl,
      discoveryIntervalMs: 60_000,
      discoveryTimeoutMs: 100,
    });

    await manager.start();
    const registerResult = await manager.register({
      userId: "flynn",
      url: "http://192.168.50.25:8765",
    });

    expect(registerResult.ok).toBe(true);
    expect(registerResult.screen).toMatchObject({
      id: "b1c2d3e4",
      fingerprint: "b1c2d3e4",
      name: "Guest iPad",
      host: "192.168.50.25",
      port: 8765,
      status: "discovered",
      intake: "manual",
      protocolVersion: 1,
      width: 1194,
      height: 834,
      scale: 2,
      contentTypes: 31,
    });

    const pairResult = await manager.pair({ userId: "flynn", screen: "Guest iPad" });
    expect(pairResult.status).toBe("paired");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://192.168.50.25:8765/identity",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://192.168.50.25:8765/pair",
      expect.objectContaining({ method: "POST" }),
    );

    await manager.stop();
    await fs.rm(statePath, { recursive: true, force: true });
  });

  it("allows explicit pair when discovery marks the screen busy", async () => {
    const statePath = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-test-"));
    const manager = createSurfAceManager({
      statePath,
      discoverImpl: async () => [
        {
          instanceName: "Surf Ace - iPad",
          host: "192.168.50.25",
          port: 8765,
          txt: {
            name: "Surf Ace - iPad",
            v: "1",
            w: "1194",
            h: "834",
            s: "2",
            cap: "31",
            busy: "1",
            pk: "23c71e1c",
          },
        },
      ],
      fetchImpl: vi.fn(async (input: RequestInfo | URL) => {
        const url =
          input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
        const pathname = new URL(url).pathname;
        if (pathname === "/pair") {
          return new Response(JSON.stringify({ status: "ok", sessionToken: "tok_busy_repair" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      }),
      discoveryIntervalMs: 60_000,
      discoveryTimeoutMs: 100,
    });

    await manager.start();
    const pairResult = await manager.pair({ userId: "flynn", screen: "Surf Ace - iPad" });
    expect(pairResult.status).toBe("paired");
    expect(pairResult.screen.sessionToken).toBe("tok_busy_repair");

    await manager.stop();
    await fs.rm(statePath, { recursive: true, force: true });
  });

  it("auto-pairs trusted screens even when discovery marks them busy", async () => {
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

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      const pathname = new URL(url).pathname;
      if (pathname === "/pair") {
        return new Response(JSON.stringify({ status: "ok", sessionToken: "tok_auto_busy" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const manager = createSurfAceManager({
      statePath,
      discoverImpl: async () => [
        {
          instanceName: "Surf Ace - iPad",
          host: "192.168.50.25",
          port: 8765,
          txt: {
            name: "Surf Ace - iPad",
            v: "1",
            w: "1194",
            h: "834",
            s: "2",
            cap: "31",
            busy: "1",
            pk: "23c71e1c",
          },
        },
      ],
      fetchImpl,
      discoveryIntervalMs: 60_000,
      discoveryTimeoutMs: 100,
    });

    await manager.start();
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://192.168.50.25:8765/pair",
      expect.objectContaining({ method: "POST" }),
    );

    const screens = manager.listScreens();
    expect(screens).toContainEqual(
      expect.objectContaining({
        id: "23c71e1c",
        sessionToken: "tok_auto_busy",
      }),
    );

    await manager.stop();
    await fs.rm(statePath, { recursive: true, force: true });
  });

  it("keeps pair session token visible when discovery refresh runs during pair", async () => {
    const statePath = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-test-"));
    const discoverImpl = vi.fn(async () => [
      {
        instanceName: "Surf Ace - iPad",
        host: "192.168.50.25",
        port: 8765,
        txt: {
          name: "Surf Ace - iPad",
          v: "1",
          w: "1194",
          h: "834",
          s: "2",
          cap: "31",
          busy: "0",
          pk: "23c71e1c",
        },
      },
    ]);

    let manager: ReturnType<typeof createSurfAceManager> | null = null;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      const pathname = new URL(url).pathname;
      if (pathname === "/pair") {
        // Reproduce the bug: discovery refresh replaces the tracked object while pair is in-flight.
        await (manager as { refreshDiscovery?: () => Promise<void> } | null)?.refreshDiscovery?.();
        return new Response(JSON.stringify({ status: "ok", sessionToken: "tok_race" }), {
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
      return new Response("not found", { status: 404 });
    });

    manager = createSurfAceManager({
      statePath,
      discoverImpl,
      fetchImpl,
      discoveryIntervalMs: 60_000,
      discoveryTimeoutMs: 100,
    });

    await manager.start();
    const pairResult = await manager.pair({ userId: "flynn", screen: "Surf Ace - iPad" });
    expect(pairResult.status).toBe("paired");

    const pushResult = await manager.push({
      userId: "flynn",
      screen: "Surf Ace - iPad",
      contentType: "html",
      title: "Race Safe",
      content: { html: "<html><body>Race Safe</body></html>" },
    });

    expect(pushResult.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://192.168.50.25:8765/frame",
      expect.objectContaining({ method: "POST" }),
    );

    await manager.stop();
    await fs.rm(statePath, { recursive: true, force: true });
  });

  it("rejects manual registration when identity fingerprint is missing", async () => {
    const statePath = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-test-"));
    const manager = createSurfAceManager({
      statePath,
      discoverImpl: async () => [],
      fetchImpl: async () =>
        new Response(JSON.stringify({ name: "No Fingerprint" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      discoveryIntervalMs: 60_000,
      discoveryTimeoutMs: 100,
    });

    await manager.start();
    await expect(
      manager.register({ userId: "flynn", url: "http://192.168.50.99:8765" }),
    ).rejects.toThrow("missing a valid fingerprint");
    await manager.stop();
    await fs.rm(statePath, { recursive: true, force: true });
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

  it("restores paired screens from disk and rearms watch on startup", async () => {
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
    const fetchInitial = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      const pathname = new URL(url).pathname;
      if (pathname === "/pair") {
        return new Response(JSON.stringify({ status: "ok", sessionToken: "tok_restore" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (pathname === "/watch") {
        return new Response("", { status: 200 });
      }
      return new Response(null, { status: 204 });
    });

    const firstManager = createSurfAceManager({
      statePath,
      discoverImpl,
      fetchImpl: fetchInitial,
      discoveryIntervalMs: 60_000,
      discoveryTimeoutMs: 100,
    });
    firstManager.setCallbackBaseUrl("http://tars.local:18800");
    await firstManager.start();
    await firstManager.pair({ userId: "flynn", screen: "Kitchen Display" });
    await firstManager.watch({ userId: "flynn", screen: "Kitchen Display", enabled: true });
    await firstManager.stop();

    const persistedPath = path.join(statePath, SCREEN_STATE_FILE);
    const persistedRaw = await fs.readFile(persistedPath, "utf8");
    const persisted = JSON.parse(persistedRaw) as {
      screens: Array<{ fingerprint: string; sessionToken: string | null; watchEnabled: boolean }>;
    };
    expect(persisted.screens).toContainEqual(
      expect.objectContaining({
        fingerprint: "a1b2c3d4",
        sessionToken: "tok_restore",
        watchEnabled: true,
      }),
    );

    const fetchRestore = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      const pathname = new URL(url).pathname;
      if (pathname === "/snapshot") {
        expect(init?.headers).toMatchObject({ Authorization: "Bearer tok_restore" });
        return new Response(null, { status: 204 });
      }
      if (pathname === "/watch") {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        expect(bodyText).toContain("/surf-ace/events/a1b2c3d4");
        return new Response("", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const restoredManager = createSurfAceManager({
      statePath,
      discoverImpl: async () => [],
      fetchImpl: fetchRestore,
      discoveryIntervalMs: 60_000,
      discoveryTimeoutMs: 100,
    });
    restoredManager.setCallbackBaseUrl("http://tars.local:18800");
    await restoredManager.start();

    const restored = restoredManager.listScreens();
    expect(restored).toHaveLength(1);
    expect(restored[0]?.id).toBe("a1b2c3d4");
    expect(restored[0]?.status).toBe("paired");
    expect(restored[0]?.watchEnabled).toBe(true);
    expect(restored[0]?.sessionToken).toBe("tok_restore");
    expect(fetchRestore).toHaveBeenCalledWith(
      expect.stringContaining("/snapshot"),
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchRestore).toHaveBeenCalledWith(
      expect.stringContaining("/watch"),
      expect.objectContaining({ method: "POST" }),
    );

    await restoredManager.stop();
    await fs.rm(statePath, { recursive: true, force: true });
  });

  it("marks restored screens as available when stored token is invalid", async () => {
    const statePath = await fs.mkdtemp(path.join(os.tmpdir(), "surf-ace-test-"));
    const persistedPath = path.join(statePath, SCREEN_STATE_FILE);
    await fs.writeFile(
      persistedPath,
      JSON.stringify(
        {
          version: 1,
          screens: [
            {
              fingerprint: "deadbeef",
              host: "10.0.0.55",
              port: 17777,
              sessionToken: "tok_old",
              watchEnabled: true,
            },
          ],
        },
        null,
        2,
      ),
    );

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      const pathname = new URL(url).pathname;
      if (pathname === "/snapshot") {
        return new Response("unauthorized", { status: 401 });
      }
      return new Response("not found", { status: 404 });
    });

    const manager = createSurfAceManager({
      statePath,
      discoverImpl: async () => [],
      fetchImpl,
      discoveryIntervalMs: 60_000,
      discoveryTimeoutMs: 100,
    });
    manager.setCallbackBaseUrl("http://tars.local:18800");
    await manager.start();

    const screens = manager.listScreens();
    expect(screens).toHaveLength(1);
    expect(screens[0]?.id).toBe("deadbeef");
    expect(screens[0]?.status).toBe("discovered");
    expect(screens[0]?.sessionToken).toBeNull();
    expect(screens[0]?.watchEnabled).toBe(false);

    const persistedAfterRaw = await fs.readFile(persistedPath, "utf8");
    const persistedAfter = JSON.parse(persistedAfterRaw) as {
      screens: Array<{ fingerprint: string; sessionToken: string | null; watchEnabled: boolean }>;
    };
    expect(persistedAfter.screens).toContainEqual(
      expect.objectContaining({
        fingerprint: "deadbeef",
        sessionToken: null,
        watchEnabled: false,
      }),
    );

    await manager.stop();
    await fs.rm(statePath, { recursive: true, force: true });
  });
});
