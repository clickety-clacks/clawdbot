import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayFromCliMock = vi.fn();

vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  callGatewayFromCli: (...args: unknown[]) => callGatewayFromCliMock(...args),
}));

import { callClawlineGatewaySessionSend } from "./gateway-alert-runtime.js";

describe("clawline gateway alert runtime", () => {
  beforeEach(() => {
    callGatewayFromCliMock.mockReset();
  });

  it("admits alerts through sessions.send and waits for the submitted run", async () => {
    callGatewayFromCliMock
      .mockResolvedValueOnce({
        runId: "alert-run",
        status: "started",
        result: { payloads: [{ type: "text", text: "ack" }] },
      })
      .mockResolvedValueOnce({ runId: "alert-run", status: "ok" });

    await expect(
      callClawlineGatewaySessionSend({
        request: {
          attachments: [{ type: "file" }],
          idempotencyKey: "alert-idem",
          message: "[OpenClaw alert]\nSource: test\n\nCheck",
          sessionKey: "agent:main:clawline:flynn:main",
        },
        timeoutMs: 1234,
        token: "test-token",
      }),
    ).resolves.toMatchObject({
      result: { payloads: [{ type: "text", text: "ack" }] },
      runId: "alert-run",
      status: "ok",
    });

    expect(callGatewayFromCliMock).toHaveBeenNthCalledWith(
      1,
      "sessions.send",
      expect.objectContaining({ token: "test-token", timeout: "1234" }),
      {
        attachments: [{ type: "file" }],
        deliver: true,
        idempotencyKey: "alert-idem",
        key: "agent:main:clawline:flynn:main",
        message: "[OpenClaw alert]\nSource: test\n\nCheck",
      },
      expect.objectContaining({ expectFinal: true }),
    );
    expect(callGatewayFromCliMock).toHaveBeenNthCalledWith(
      2,
      "agent.wait",
      expect.objectContaining({ token: "test-token", timeout: "1234" }),
      { runId: "alert-run", timeoutMs: 1234 },
      expect.objectContaining({ expectFinal: true }),
    );
  });

  it("rejects when the submitted alert run does not complete", async () => {
    callGatewayFromCliMock
      .mockResolvedValueOnce({ runId: "alert-run", status: "started" })
      .mockResolvedValueOnce({ runId: "alert-run", status: "timeout" });

    await expect(
      callClawlineGatewaySessionSend({
        request: {
          idempotencyKey: "alert-idem",
          message: "Check",
          sessionKey: "agent:main:main",
        },
      }),
    ).rejects.toThrow("sessions.send alert run did not complete");
  });
});
