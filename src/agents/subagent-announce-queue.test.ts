// Announce queue tests cover poison-item recovery and overflow drain behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../runtime.js";
import type { AnnounceQueueItem } from "./subagent-announce-queue.js";
import { enqueueAnnounce, resetAnnounceQueuesForTests } from "./subagent-announce-queue.js";

describe("enqueueAnnounce", () => {
  let previousTestFast: string | undefined;

  beforeEach(() => {
    previousTestFast = process.env.OPENCLAW_TEST_FAST;
    process.env.OPENCLAW_TEST_FAST = "1";
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
    resetAnnounceQueuesForTests();
  });

  afterEach(() => {
    resetAnnounceQueuesForTests();
    vi.restoreAllMocks();
    if (previousTestFast === undefined) {
      delete process.env.OPENCLAW_TEST_FAST;
    } else {
      process.env.OPENCLAW_TEST_FAST = previousTestFast;
    }
  });

  it("quarantines a poison announce item after repeated drain failures", async () => {
    const send = vi
      .fn<(item: AnnounceQueueItem) => Promise<void>>()
      .mockRejectedValueOnce(new Error("token invalidated"))
      .mockRejectedValueOnce(new Error("token invalidated"))
      .mockRejectedValueOnce(new Error("token invalidated"))
      .mockResolvedValueOnce(undefined);
    const item = {
      prompt: "first alert",
      summaryLine: "first summary",
      enqueuedAt: Date.now(),
      sessionKey: "agent:main",
    };

    enqueueAnnounce({
      key: "agent:main",
      item,
      settings: { mode: "queue", debounceMs: 0, cap: 10 },
      send,
    });
    enqueueAnnounce({
      key: "agent:main",
      item: {
        prompt: "second alert",
        summaryLine: "second summary",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main",
      },
      settings: { mode: "queue", debounceMs: 0, cap: 10 },
      send,
    });

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(4);
    });

    expect(send.mock.calls.map(([queued]) => queued.prompt)).toEqual([
      "first alert",
      "first alert",
      "first alert",
      "second alert",
    ]);
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("announce queue recovery quarantined one undeliverable item"),
    );
  });

  it("clears failed overflow summary state and retries the live item", async () => {
    const send = vi
      .fn<(item: AnnounceQueueItem) => Promise<void>>()
      .mockRejectedValueOnce(new Error("too long"))
      .mockRejectedValueOnce(new Error("too long"))
      .mockRejectedValueOnce(new Error("too long"))
      .mockResolvedValueOnce(undefined);

    enqueueAnnounce({
      key: "agent:main",
      item: {
        prompt: "first alert",
        summaryLine: "first summary",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main",
      },
      settings: { mode: "queue", debounceMs: 0, cap: 1, dropPolicy: "summarize" },
      send,
    });
    enqueueAnnounce({
      key: "agent:main",
      item: {
        prompt: "second alert",
        summaryLine: "second summary",
        enqueuedAt: Date.now(),
        sessionKey: "agent:main",
      },
      settings: { mode: "queue", debounceMs: 0, cap: 1, dropPolicy: "summarize" },
      send,
    });

    await vi.waitFor(() => {
      expect(defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining("announce queue recovery cleared overflow summary"),
      );
    });
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(4);
    });

    expect(send.mock.calls.at(-1)?.[0].prompt).toBe("second alert");
  });
});
