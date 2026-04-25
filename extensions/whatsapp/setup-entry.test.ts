import { describe, expect, it, vi } from "vitest";

vi.mock("@whiskeysockets/baileys", () => {
  throw new Error("setup plugin load must not load Baileys");
});

describe("whatsapp setup entry", () => {
  it("loads the setup plugin without installing or importing runtime dependencies", async () => {
    const { default: setupEntry } = await import("./setup-entry.js");

    expect(setupEntry.kind).toBe("bundled-channel-setup-entry");
    expect(setupEntry.loadSetupPlugin({ installRuntimeDeps: false }).id).toBe("whatsapp");
  });

  it("loads the delegated setup wizard without importing runtime dependencies", async () => {
    const { whatsappSetupWizard } = await import("./src/setup-surface.js");

    expect(whatsappSetupWizard.channel).toBe("whatsapp");
  });
});
