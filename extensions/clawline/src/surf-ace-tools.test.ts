import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = {
  list: vi.fn(),
  push: vi.fn(),
  clear: vi.fn(),
  read: vi.fn(),
  annotationsRemove: vi.fn(),
};

vi.mock("./surf-ace-runtime.js", () => ({
  requireClawlineSurfAceRuntime: () => runtime,
}));

import { createSurfAceTools } from "./surf-ace-tools.js";

describe("createSurfAceTools", () => {
  beforeEach(() => {
    runtime.list.mockReset();
    runtime.push.mockReset();
    runtime.clear.mockReset();
    runtime.read.mockReset();
    runtime.annotationsRemove.mockReset();
  });

  it("creates the expected tool set for clawline context", () => {
    const tools = createSurfAceTools({
      context: {
        sessionKey: "agent:main:clawline:flynn:main",
      },
    });

    expect(tools.map((tool) => tool.name).toSorted()).toEqual([
      "surf_ace_annotations_remove",
      "surf_ace_clear",
      "surf_ace_list",
      "surf_ace_push",
      "surf_ace_read",
    ]);
  });

  it("returns no tools outside clawline context", () => {
    const tools = createSurfAceTools({
      context: {
        sessionKey: "agent:main:main",
        messageChannel: "telegram",
      },
    });

    expect(tools).toHaveLength(0);
  });

  it("passes clawline user context to runtime calls", async () => {
    runtime.list.mockResolvedValue([]);
    runtime.push.mockResolvedValue({ fingerprint: "a1b2c3d4", contentId: "ct_123", revision: 1 });
    runtime.clear.mockResolvedValue({ fingerprint: "a1b2c3d4", revision: 2 });
    runtime.read.mockResolvedValue({ fingerprint: "a1b2c3d4" });
    runtime.annotationsRemove.mockResolvedValue({
      fingerprint: "a1b2c3d4",
      removedStrokeIds: ["stroke_1"],
      notFoundStrokeIds: [],
      remainingStrokeCount: 0,
    });

    const tools = createSurfAceTools({
      context: {
        sessionKey: "agent:main:clawline:flynn:main",
      },
    });

    const list = tools.find((tool) => tool.name === "surf_ace_list");
    const push = tools.find((tool) => tool.name === "surf_ace_push");
    const clear = tools.find((tool) => tool.name === "surf_ace_clear");
    const read = tools.find((tool) => tool.name === "surf_ace_read");
    const remove = tools.find((tool) => tool.name === "surf_ace_annotations_remove");

    await list?.execute?.("call-0", {}, undefined);
    await push?.execute?.(
      "call-1",
      {
        fingerprint: "a1b2c3d4",
        contentType: "html",
        content: "<html/>",
      },
      undefined,
    );
    await clear?.execute?.("call-2", { fingerprint: "a1b2c3d4" }, undefined);
    await read?.execute?.("call-3", { fingerprint: "a1b2c3d4" }, undefined);
    await remove?.execute?.(
      "call-4",
      {
        fingerprint: "a1b2c3d4",
        contentId: "ct_123",
        strokeIds: ["stroke_1"],
      },
      undefined,
    );

    expect(runtime.list).toHaveBeenCalledWith({ userId: "flynn" });
    expect(runtime.push).toHaveBeenCalledWith({
      userId: "flynn",
      fingerprint: "a1b2c3d4",
      contentType: "html",
      content: "<html/>",
    });
    expect(runtime.clear).toHaveBeenCalledWith({ userId: "flynn", fingerprint: "a1b2c3d4" });
    expect(runtime.read).toHaveBeenCalledWith({ userId: "flynn", fingerprint: "a1b2c3d4" });
    expect(runtime.annotationsRemove).toHaveBeenCalledWith({
      userId: "flynn",
      fingerprint: "a1b2c3d4",
      contentId: "ct_123",
      strokeIds: ["stroke_1"],
    });
  });
});
