import { describe, expect, it, vi } from "vitest";
import pluginEntry from "../index.js";
import setupEntry from "../setup-entry.js";

describe("clawline plugin entry", () => {
  it("declares the bundled channel entry contract", () => {
    expect(pluginEntry.kind).toBe("bundled-channel-entry");
    expect(pluginEntry.id).toBe("clawline");
    expect(pluginEntry.name).toBe("Clawline");
    expect(typeof pluginEntry.loadChannelPlugin).toBe("function");
  });

  it("registers the channel in setup mode without wiring the service", () => {
    const registerChannel = vi.fn();
    const registerService = vi.fn();

    pluginEntry.register?.({
      registerChannel,
      registerService,
      registrationMode: "setup",
      runtime: {} as never,
    } as never);

    expect(registerChannel).toHaveBeenCalledWith({
      plugin: expect.objectContaining({ id: "clawline" }),
    });
    expect(registerService).not.toHaveBeenCalled();
  });

  it("registers the service in full mode", () => {
    const registerChannel = vi.fn();
    const registerService = vi.fn();

    pluginEntry.register?.({
      registerChannel,
      registerService,
      registrationMode: "full",
      runtime: {} as never,
    } as never);

    expect(registerChannel).toHaveBeenCalledWith({
      plugin: expect.objectContaining({ id: "clawline" }),
    });
    expect(registerService).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "clawline",
        start: expect.any(Function),
        stop: expect.any(Function),
      }),
    );
  });

  it("declares the bundled setup entry contract", () => {
    expect(setupEntry.kind).toBe("bundled-channel-setup-entry");
    expect(typeof setupEntry.loadSetupPlugin).toBe("function");
  });
});
