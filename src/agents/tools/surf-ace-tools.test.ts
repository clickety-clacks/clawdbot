import { describe, expect, it, vi, beforeEach } from "vitest";

const runtime = {
  pair: vi.fn(),
  push: vi.fn(),
  watch: vi.fn(),
  clear: vi.fn(),
  snapshot: vi.fn(),
};

vi.mock("../../clawline/surf-ace-runtime.js", () => ({
  requireClawlineSurfAceRuntime: () => runtime,
}));

import { createSurfAceTools } from "./surf-ace-tools.js";

describe("createSurfAceTools", () => {
  beforeEach(() => {
    runtime.pair.mockReset();
    runtime.push.mockReset();
    runtime.watch.mockReset();
    runtime.clear.mockReset();
    runtime.snapshot.mockReset();
  });

  it("creates the expected tool set", () => {
    const tools = createSurfAceTools({
      agentSessionKey: "agent:main:clawline:flynn:main",
    });

    expect(tools.map((tool) => tool.name).toSorted()).toEqual([
      "surf_ace_clear",
      "surf_ace_pair",
      "surf_ace_push",
      "surf_ace_snapshot",
      "surf_ace_watch",
    ]);
  });

  it("passes clawline user context to runtime calls", async () => {
    runtime.pair.mockResolvedValue({ ok: true, status: "paired" });
    runtime.push.mockResolvedValue({ ok: true, frameId: "fr_1" });
    runtime.watch.mockResolvedValue({ ok: true, enabled: true });
    runtime.clear.mockResolvedValue({ ok: true });
    runtime.snapshot.mockResolvedValue({ ok: true, status: "no_content" });

    const tools = createSurfAceTools({
      agentSessionKey: "agent:main:clawline:flynn:main",
    });

    const pair = tools.find((tool) => tool.name === "surf_ace_pair");
    const push = tools.find((tool) => tool.name === "surf_ace_push");
    const watch = tools.find((tool) => tool.name === "surf_ace_watch");
    const clear = tools.find((tool) => tool.name === "surf_ace_clear");
    const snapshot = tools.find((tool) => tool.name === "surf_ace_snapshot");

    await pair?.execute?.("call-1", { screen: "Kitchen" }, undefined);
    await push?.execute?.(
      "call-2",
      {
        screen: "Kitchen",
        contentType: "html",
        content: { html: "<html/>" },
        sourceRefSessionKey: "agent:main:clawline:flynn:main",
        sourceRefMessageId: "s_123",
      },
      undefined,
    );
    await watch?.execute?.("call-3", { screen: "Kitchen", enabled: true }, undefined);
    await clear?.execute?.("call-4", { screen: "Kitchen" }, undefined);
    await snapshot?.execute?.("call-5", { screen: "Kitchen" }, undefined);

    expect(runtime.pair).toHaveBeenCalledWith({
      userId: "flynn",
      screen: "Kitchen",
    });
    expect(runtime.push).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "flynn",
        screen: "Kitchen",
        sourceRef: {
          sessionKey: "agent:main:clawline:flynn:main",
          messageId: "s_123",
        },
      }),
    );
    expect(runtime.watch).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "flynn", screen: "Kitchen", enabled: true }),
    );
    expect(runtime.clear).toHaveBeenCalledWith({ userId: "flynn", screen: "Kitchen" });
    expect(runtime.snapshot).toHaveBeenCalledWith({ userId: "flynn", screen: "Kitchen" });
  });
});
