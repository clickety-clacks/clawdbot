import { describe, expect, it, vi } from "vitest";
import type { SurfAceRuntime } from "../../clawline/surf-ace.js";

describe("Surf Ace runtime sharing", () => {
  it("exposes runtime across isolated modules so tools can resolve it", async () => {
    const providerRuntimeModule = await import("../../clawline/surf-ace-runtime.js?provider");
    const toolsRuntimeModule = await import("../../clawline/surf-ace-runtime.js");
    const { createSurfAceTools } = await import("./surf-ace-tools.js?tools");

    const snapshot = vi.fn(async () => ({ ok: true, status: "no_content" }));
    providerRuntimeModule.setClawlineSurfAceRuntime({ snapshot } as unknown as SurfAceRuntime);

    try {
      expect(toolsRuntimeModule.hasClawlineSurfAceRuntime()).toBe(true);

      const tools = createSurfAceTools({
        agentSessionKey: "agent:main:clawline:flynn:main",
      });
      const snapshotTool = tools.find((tool) => tool.name === "surf_ace_snapshot");
      expect(snapshotTool).toBeDefined();

      await snapshotTool?.execute?.("call-1", { screen: "Kitchen Display" }, undefined);
      expect(snapshot).toHaveBeenCalledWith({
        userId: "flynn",
        screen: "Kitchen Display",
      });
    } finally {
      toolsRuntimeModule.setClawlineSurfAceRuntime(null);
      expect(toolsRuntimeModule.hasClawlineSurfAceRuntime()).toBe(false);
    }
  });
});
