import { describe, expect, it, vi } from "vitest";
import pluginEntry from "../index.js";
import { clawlinePlugin } from "./channel.js";

describe("clawline plugin entry", () => {
  it("registers the channel in setup mode without wiring the service", () => {
    const registerChannel = vi.fn();
    const registerService = vi.fn();

    pluginEntry.register?.({
      registerChannel,
      registerService,
      registrationMode: "setup",
      runtime: {} as never,
    } as never);

    expect(registerChannel).toHaveBeenCalledWith({ plugin: clawlinePlugin });
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

    expect(registerChannel).toHaveBeenCalledWith({ plugin: clawlinePlugin });
    expect(registerService).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "clawline",
        start: expect.any(Function),
        stop: expect.any(Function),
      }),
    );
  });
});
