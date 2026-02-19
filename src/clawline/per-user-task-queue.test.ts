import { describe, expect, it } from "vitest";
import { createPerUserTaskQueue } from "./per-user-task-queue.js";

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(count = 3) {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
}

describe("per-user-task-queue", () => {
  it("before-fix control: user-only key serializes different streams", async () => {
    const queue = createPerUserTaskQueue({
      resolveQueueKey: ({ userId }) => userId,
    });
    const firstGate = createDeferred();
    const timeline: string[] = [];
    let streamAStarted = false;
    let streamBStarted = false;

    const streamA = queue.run({ userId: "user-1", streamKey: "stream-a" }, async () => {
      streamAStarted = true;
      timeline.push("a:start");
      await firstGate.promise;
      timeline.push("a:end");
    });
    const streamB = queue.run({ userId: "user-1", streamKey: "stream-b" }, async () => {
      streamBStarted = true;
      timeline.push("b:start");
      timeline.push("b:end");
    });

    await flushMicrotasks();
    expect(streamAStarted).toBe(true);
    expect(streamBStarted).toBe(false);

    firstGate.resolve();
    await Promise.all([streamA, streamB]);
    expect(timeline).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("after fix: different streams for the same user run in parallel", async () => {
    const queue = createPerUserTaskQueue();
    const gateA = createDeferred();
    const gateB = createDeferred();
    let streamAStarted = false;
    let streamBStarted = false;

    const streamA = queue.run({ userId: "user-1", streamKey: "stream-a" }, async () => {
      streamAStarted = true;
      await gateA.promise;
    });
    const streamB = queue.run({ userId: "user-1", streamKey: "stream-b" }, async () => {
      streamBStarted = true;
      await gateB.promise;
    });

    await flushMicrotasks();
    expect(streamAStarted).toBe(true);
    expect(streamBStarted).toBe(true);

    gateA.resolve();
    gateB.resolve();
    await Promise.all([streamA, streamB]);
  });

  it("same stream remains serialized", async () => {
    const queue = createPerUserTaskQueue();
    const gateA = createDeferred();
    const gateB = createDeferred();
    const timeline: string[] = [];
    let streamAStarted = false;
    let streamBStarted = false;

    const streamA = queue.run({ userId: "user-1", streamKey: "stream-a" }, async () => {
      streamAStarted = true;
      timeline.push("a:start");
      await gateA.promise;
      timeline.push("a:end");
    });
    const streamB = queue.run({ userId: "user-1", streamKey: "stream-a" }, async () => {
      streamBStarted = true;
      timeline.push("b:start");
      await gateB.promise;
      timeline.push("b:end");
    });

    await flushMicrotasks();
    expect(streamAStarted).toBe(true);
    expect(streamBStarted).toBe(false);

    gateA.resolve();
    await streamA;
    await flushMicrotasks();
    expect(streamBStarted).toBe(true);

    gateB.resolve();
    await streamB;
    expect(timeline).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });
});
