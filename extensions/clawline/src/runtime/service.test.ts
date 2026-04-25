import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawlineOutboundSendResult, ProviderServer } from "./domain.js";

const resolveStorePathMock = vi.hoisted(() => vi.fn(() => "/tmp/clawline-session-store.json"));
const resolveMainSessionKeyMock = vi.hoisted(() => vi.fn(() => "agent:main:main"));
const resolveAgentIdFromSessionKeyMock = vi.hoisted(() => vi.fn(() => "main"));
const resolveClawlineConfigMock = vi.hoisted(() => vi.fn());
const createProviderServerMock = vi.hoisted(() => vi.fn<() => Promise<ProviderServer>>());

vi.mock("../runtime-api.js", async () => {
  const actual = await vi.importActual("../runtime-api.js");
  return {
    ...actual,
    resolveStorePath: resolveStorePathMock,
    resolveAgentIdFromSessionKey: resolveAgentIdFromSessionKeyMock,
  };
});

vi.mock("./session-compat.js", async () => {
  const actual = await vi.importActual("./session-compat.js");
  return {
    ...actual,
    resolveClawlineMainSessionKey: resolveMainSessionKeyMock,
  };
});

vi.mock("./config.js", () => ({
  resolveClawlineConfig: resolveClawlineConfigMock,
}));

vi.mock("./server.js", () => ({
  createProviderServer: createProviderServerMock,
}));

describe("startClawlineService", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    resolveStorePathMock.mockReturnValue("/tmp/clawline-session-store.json");
    resolveMainSessionKeyMock.mockReturnValue("agent:main:main");
    resolveAgentIdFromSessionKeyMock.mockReturnValue("main");
  });

  afterEach(async () => {
    const { setClawlineOutboundSender } = await import("./outbound.js");
    setClawlineOutboundSender(null);
  });

  it("does not register an outbound sender when clawline is disabled", async () => {
    resolveClawlineConfigMock.mockReturnValue({
      enabled: false,
    });
    const { startClawlineService } = await import("./service.js");
    const outbound = await import("./outbound.js");

    await expect(startClawlineService({ config: {}, logger: console })).resolves.toBeNull();
    expect(createProviderServerMock).not.toHaveBeenCalled();
    expect(outbound.hasClawlineOutboundSender()).toBe(false);
  });

  it("registers the outbound sender on start and clears it on stop", async () => {
    const sendResult: ClawlineOutboundSendResult = {
      messageId: "msg-1",
      userId: "flynn",
      deviceId: "device-1",
    };
    const sendMessageMock = vi.fn(async () => sendResult);
    const startMock = vi.fn(async () => {});
    const stopMock = vi.fn(async () => {});

    resolveClawlineConfigMock.mockReturnValue({
      enabled: true,
      port: 18800,
      network: {
        bindAddress: "127.0.0.1",
      },
    });
    createProviderServerMock.mockResolvedValue({
      start: startMock,
      stop: stopMock,
      getPort: () => 19191,
      sendMessage: sendMessageMock,
    });

    const { startClawlineService } = await import("./service.js");
    const outbound = await import("./outbound.js");
    const handle = await startClawlineService({
      config: { channels: { clawline: { enabled: true } } },
      logger: console,
    });

    expect(handle).not.toBeNull();
    expect(startMock).toHaveBeenCalledTimes(1);
    expect(createProviderServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionStorePath: "/tmp/clawline-session-store.json",
        mainSessionKey: "agent:main:main",
      }),
    );
    expect(outbound.hasClawlineOutboundSender()).toBe(true);

    await expect(
      outbound.sendClawlineOutboundMessage({
        target: "flynn:main",
        text: "hello",
      }),
    ).resolves.toEqual(sendResult);
    expect(sendMessageMock).toHaveBeenCalledWith({
      target: "flynn:main",
      text: "hello",
    });

    await handle?.stop();

    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(outbound.hasClawlineOutboundSender()).toBe(false);
    await expect(
      outbound.sendClawlineOutboundMessage({
        target: "flynn:main",
        text: "after-stop",
      }),
    ).rejects.toThrow("clawline outbound delivery is not available (service not running)");
  });

  it("does not let an older service stop clear a newer sender registration", async () => {
    const sendMessageMockA = vi.fn(async () => ({
      messageId: "msg-a",
      userId: "flynn",
      deviceId: "device-a",
    }));
    const sendMessageMockB = vi.fn(async () => ({
      messageId: "msg-b",
      userId: "flynn",
      deviceId: "device-b",
    }));
    const stopMockA = vi.fn(async () => {});
    const stopMockB = vi.fn(async () => {});

    resolveClawlineConfigMock.mockReturnValue({
      enabled: true,
      port: 18800,
      network: {
        bindAddress: "127.0.0.1",
      },
    });
    createProviderServerMock
      .mockResolvedValueOnce({
        start: vi.fn(async () => {}),
        stop: stopMockA,
        getPort: () => 19191,
        sendMessage: sendMessageMockA,
      })
      .mockResolvedValueOnce({
        start: vi.fn(async () => {}),
        stop: stopMockB,
        getPort: () => 19192,
        sendMessage: sendMessageMockB,
      });

    const { startClawlineService } = await import("./service.js");
    const outbound = await import("./outbound.js");

    const handleA = await startClawlineService({
      config: { channels: { clawline: { enabled: true } } },
      logger: console,
    });
    const handleB = await startClawlineService({
      config: { channels: { clawline: { enabled: true } } },
      logger: console,
    });

    await expect(
      outbound.sendClawlineOutboundMessage({
        target: "flynn:main",
        text: "before older stop",
      }),
    ).resolves.toEqual({
      messageId: "msg-b",
      userId: "flynn",
      deviceId: "device-b",
    });

    await handleA?.stop();

    await expect(
      outbound.sendClawlineOutboundMessage({
        target: "flynn:main",
        text: "after older stop",
      }),
    ).resolves.toEqual({
      messageId: "msg-b",
      userId: "flynn",
      deviceId: "device-b",
    });
    expect(stopMockA).toHaveBeenCalledTimes(1);
    expect(stopMockB).not.toHaveBeenCalled();

    await handleB?.stop();

    expect(stopMockB).toHaveBeenCalledTimes(1);
    await expect(
      outbound.sendClawlineOutboundMessage({
        target: "flynn:main",
        text: "after latest stop",
      }),
    ).rejects.toThrow("clawline outbound delivery is not available (service not running)");
  });
});
