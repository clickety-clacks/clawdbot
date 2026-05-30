import { describe, expect, it } from "vitest";
import { createClawlineProviderLaneQueue, createPerUserTaskQueue } from "./per-user-task-queue.js";

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

async function waitForTimeline(predicate: () => boolean) {
  for (let i = 0; i < 20; i += 1) {
    await flushMicrotasks();
    if (predicate()) {
      return;
    }
  }
  throw new Error("Timed out waiting for expected queue timeline");
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

describe("clawline provider lane queue", () => {
  it("admits unrelated stream and control work while a prompt turn is running", async () => {
    const queue = createClawlineProviderLaneQueue();
    const promptGate = createDeferred();
    const timeline: string[] = [];

    const promptTurn = queue.runPromptTurn(
      { userId: "user-1", streamKey: "stream-a" },
      async () => {
        timeline.push("prompt-a:start");
        await promptGate.promise;
        timeline.push("prompt-a:end");
      },
    );

    await flushMicrotasks();

    const promptAdmission = queue.runPromptAdmission(
      { userId: "user-1", streamKey: "stream-b" },
      async () => {
        timeline.push("prompt-b:admitted");
      },
    );
    const controlAdmission = queue.runControl({ userId: "user-1" }, async () => {
      timeline.push("control:admitted");
    });

    await Promise.all([promptAdmission, controlAdmission]);
    expect(timeline).toEqual(["prompt-a:start", "prompt-b:admitted", "control:admitted"]);

    promptGate.resolve();
    await promptTurn;
    expect(timeline).toEqual([
      "prompt-a:start",
      "prompt-b:admitted",
      "control:admitted",
      "prompt-a:end",
    ]);
  });

  it("keeps same-stream prompt turns ordered by normalized stream key", async () => {
    const queue = createClawlineProviderLaneQueue();
    const firstGate = createDeferred();
    const secondGate = createDeferred();
    const timeline: string[] = [];
    let secondStarted = false;

    const first = queue.runPromptTurn({ userId: "user-1", streamKey: " Stream-A " }, async () => {
      timeline.push("first:start");
      await firstGate.promise;
      timeline.push("first:end");
    });
    const second = queue.runPromptTurn({ userId: "user-1", streamKey: "stream-a" }, async () => {
      secondStarted = true;
      timeline.push("second:start");
      await secondGate.promise;
      timeline.push("second:end");
    });

    await flushMicrotasks();
    expect(secondStarted).toBe(false);

    firstGate.resolve();
    await first;
    await flushMicrotasks();
    expect(secondStarted).toBe(true);

    secondGate.resolve();
    await second;
    expect(timeline).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("runs different prompt streams independently", async () => {
    const queue = createClawlineProviderLaneQueue();
    const gateA = createDeferred();
    const gateB = createDeferred();
    let streamAStarted = false;
    let streamBStarted = false;

    const streamA = queue.runPromptTurn({ userId: "user-1", streamKey: "stream-a" }, async () => {
      streamAStarted = true;
      await gateA.promise;
    });
    const streamB = queue.runPromptTurn({ userId: "user-1", streamKey: "stream-b" }, async () => {
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

  it("admits control and local lanes independently of prompt admission", async () => {
    const queue = createClawlineProviderLaneQueue();
    const promptAdmissionGate = createDeferred();
    const timeline: string[] = [];
    let nextPromptAdmissionStarted = false;

    const promptAdmission = queue.runPromptAdmission({ userId: "user-1" }, async () => {
      timeline.push("prompt-admission:start");
      await promptAdmissionGate.promise;
      timeline.push("prompt-admission:end");
    });
    const nextPromptAdmission = queue.runPromptAdmission({ userId: "user-1" }, async () => {
      nextPromptAdmissionStarted = true;
      timeline.push("prompt-admission-next");
    });

    await flushMicrotasks();
    expect(nextPromptAdmissionStarted).toBe(false);

    const controlAdmission = queue.runControl({ userId: "user-1" }, async () => {
      timeline.push("control");
    });
    const localAdmission = queue.runLocal({ userId: "user-1" }, async () => {
      timeline.push("local");
    });

    await Promise.all([controlAdmission, localAdmission]);
    expect(timeline).toEqual(["prompt-admission:start", "control", "local"]);
    expect(nextPromptAdmissionStarted).toBe(false);

    promptAdmissionGate.resolve();
    await Promise.all([promptAdmission, nextPromptAdmission]);
    expect(timeline).toEqual([
      "prompt-admission:start",
      "control",
      "local",
      "prompt-admission:end",
      "prompt-admission-next",
    ]);
  });

  it("releases prompt admission before running the prompt turn", async () => {
    const queue = createClawlineProviderLaneQueue();
    const promptTurnGate = createDeferred();
    const timeline: string[] = [];

    const promptTurn = queue.runPromptTurnAfterAdmission(
      { userId: "user-1", streamKey: "stream-a" },
      async () => {
        timeline.push("admission");
        return "prepared";
      },
      async (prepared) => {
        timeline.push(`turn:${prepared}`);
        await promptTurnGate.promise;
      },
    );

    await flushMicrotasks();
    const nextAdmission = queue.runPromptAdmission({ userId: "user-1" }, async () => {
      timeline.push("next-admission");
    });

    await nextAdmission;
    expect(timeline).toEqual(["admission", "next-admission", "turn:prepared"]);

    promptTurnGate.resolve();
    await promptTurn;
  });

  it("serializes same-stream turns after independent admissions finish", async () => {
    const queue = createClawlineProviderLaneQueue();
    const firstGate = createDeferred();
    const secondGate = createDeferred();
    const timeline: string[] = [];

    const first = queue.runPromptTurnAfterAdmission(
      { userId: "user-1", streamKey: "stream-a" },
      async () => {
        timeline.push("first:admission");
        return "first";
      },
      async (prepared) => {
        timeline.push(`${prepared}:turn:start`);
        await firstGate.promise;
        timeline.push(`${prepared}:turn:end`);
      },
    );
    const second = queue.runPromptTurnAfterAdmission(
      { userId: "user-1", streamKey: "STREAM-A" },
      async () => {
        timeline.push("second:admission");
        return "second";
      },
      async (prepared) => {
        timeline.push(`${prepared}:turn:start`);
        await secondGate.promise;
        timeline.push(`${prepared}:turn:end`);
      },
    );

    await waitForTimeline(() => timeline.includes("first:turn:start"));
    await waitForTimeline(() => timeline.includes("second:admission"));
    expect(timeline).toContain("first:admission");
    expect(timeline).toContain("first:turn:start");
    expect(timeline).toContain("second:admission");
    expect(timeline).not.toContain("second:turn:start");

    firstGate.resolve();
    await first;
    await waitForTimeline(() => timeline.includes("second:turn:start"));
    expect(timeline.indexOf("second:turn:start")).toBeGreaterThan(
      timeline.indexOf("first:turn:end"),
    );

    secondGate.resolve();
    await second;
    expect(timeline.at(-1)).toBe("second:turn:end");
  });
});
