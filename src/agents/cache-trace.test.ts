import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveUserPath } from "../utils.js";
import { createCacheTrace } from "./cache-trace.js";

describe("createCacheTrace", () => {
  function createMemoryTraceForTest() {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
          },
        },
      },
      env: {},
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });
    return { lines, trace };
  }

  it("returns null when diagnostics cache tracing is disabled", () => {
    const trace = createCacheTrace({
      cfg: {} as OpenClawConfig,
      env: {},
    });

    expect(trace).toBeNull();
  });

  it("honors diagnostics cache trace config and expands file paths", () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
            filePath: "~/.openclaw/logs/cache-trace.jsonl",
          },
        },
      },
      env: {},
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });

    expect(typeof trace?.recordStage).toBe("function");
    expect(trace?.filePath).toBe(resolveUserPath("~/.openclaw/logs/cache-trace.jsonl"));

    trace?.recordStage("session:loaded", {
      messages: [],
      system: "sys",
    });

    expect(lines.length).toBe(1);
  });

  it("records empty prompt/system values when enabled", () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
            includePrompt: true,
            includeSystem: true,
          },
        },
      },
      env: {},
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });

    trace?.recordStage("prompt:before", { prompt: "", system: "" });

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.prompt).toBe("");
    expect(event.system).toBe("");
  });

  it("records raw model run session stages", () => {
    const { lines, trace } = createMemoryTraceForTest();

    trace?.recordStage("session:raw-model-run", {
      messages: [],
      system: "",
    });

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.stage).toBe("session:raw-model-run");
    expect(event.system).toBe("");
  });

  it("records runner timing stages without prompt or message content", () => {
    const { lines, trace } = createMemoryTraceForTest();

    trace?.recordStage("runner:prep-stages", {
      prompt: "do not persist",
      system: "do not persist",
      messages: [{ role: "user", content: "do not persist" }] as unknown as [],
      model: { provider: "do-not-persist" },
      options: { prompt: "do-not-persist" },
      note: "do not persist",
      error: "do not persist",
      timing: {
        phase: "stream-ready",
        totalMs: 42,
        stages: [
          { name: "workspace-sandbox", durationMs: 10, elapsedMs: 10 },
          { name: "stream-setup", durationMs: 32, elapsedMs: 42 },
        ],
      },
    });

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.stage).toBe("runner:prep-stages");
    expect(event.runId).toBeUndefined();
    expect(event.sessionId).toBeUndefined();
    expect(event.sessionKey).toBeUndefined();
    expect(event.provider).toBeUndefined();
    expect(event.modelId).toBeUndefined();
    expect(event.workspaceDir).toBeUndefined();
    expect(event.timing).toEqual({
      phase: "stream-ready",
      totalMs: 42,
      stages: [
        { name: "workspace-sandbox", durationMs: 10, elapsedMs: 10 },
        { name: "stream-setup", durationMs: 32, elapsedMs: 42 },
      ],
    });
    expect(event).not.toHaveProperty("prompt");
    expect(event).not.toHaveProperty("system");
    expect(event).not.toHaveProperty("model");
    expect(event).not.toHaveProperty("options");
    expect(event).not.toHaveProperty("messages");
    expect(event).not.toHaveProperty("messageCount");
    expect(event).not.toHaveProperty("note");
    expect(event).not.toHaveProperty("error");
  });

  it("records stream context from systemPrompt when wrapping stream functions", () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
            includeSystem: true,
          },
        },
      },
      env: {},
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });

    const wrapped = trace?.wrapStreamFn(((model: unknown, context: unknown, options: unknown) => ({
      model,
      context,
      options,
    })) as never);

    void wrapped?.(
      {
        id: "gpt-5.4",
        provider: "openai",
        api: "openai-responses",
      } as never,
      {
        systemPrompt: "system prompt text",
        messages: [],
      } as never,
      {},
    );

    const event = lines
      .map((line) => JSON.parse(line.trim()) as Record<string, unknown>)
      .find((entry) => entry.stage === "stream:context");
    expect(event?.stage).toBe("stream:context");
    expect(event?.system).toBe("system prompt text");
    expect(event?.systemDigest).toBeTypeOf("string");
  });

  it("records model call timing stages without prompt or body content", async () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
            includeMessages: false,
            includeSystem: false,
            includePrompt: false,
          },
        },
      },
      env: {},
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });
    const wrapped = trace?.wrapStreamFn(async function* () {
      yield { type: "text", text: "do not persist" };
    } as never);

    const result = wrapped?.(
      {
        id: "gpt-5.5",
        provider: "openai",
        api: "openai-responses",
      } as never,
      {
        systemPrompt: "do not persist",
        messages: [{ role: "user", content: "do not persist" }],
      } as never,
      { apiKey: "sk-do-not-persist" },
    ) as AsyncIterable<unknown> | undefined;

    for await (const _chunk of result ?? []) {
      // Exhaust the observed stream so terminal timing is recorded.
    }

    const events = lines.map((line) => JSON.parse(line.trim()) as Record<string, unknown>);
    expect(events.map((event) => event.stage)).toEqual([
      "model:call:start",
      "stream:context",
      "model:call:first-byte",
      "model:call:end",
    ]);
    const firstByte = events[2] as { options?: Record<string, unknown> };
    const end = events[3] as { options?: Record<string, unknown> };
    expect(firstByte.options?.timeToFirstByteMs).toBeTypeOf("number");
    expect(end.options?.durationMs).toBeTypeOf("number");
    for (const event of events) {
      expect(event).not.toHaveProperty("prompt");
      expect(JSON.stringify(event)).not.toContain("do not persist");
      expect(JSON.stringify(event)).not.toContain("sk-do-not-persist");
    }
  });

  it("forwards early stream cancellation to the wrapped iterator", async () => {
    const { trace } = createMemoryTraceForTest();
    let returned = false;
    const stream = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ done: false, value: { type: "text_delta" } }),
          return: async () => {
            returned = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const wrapped = trace?.wrapStreamFn(() => stream as never);
    const result = wrapped?.(
      { id: "gpt-5.5", provider: "openai", api: "openai-responses" } as never,
      {
        messages: [],
      } as never,
    ) as AsyncIterable<unknown> | undefined;
    const iterator = result?.[Symbol.asyncIterator]();

    await iterator?.next();
    await iterator?.return?.();

    expect(returned).toBe(true);
  });

  it("records model call errors without raw error names or messages", () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
            includeMessages: false,
            includeSystem: false,
            includePrompt: false,
          },
        },
      },
      env: {},
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });
    const err = new Error("secret prompt body");
    err.name = "sk-secret-error-name";
    const wrapped = trace?.wrapStreamFn(() => {
      throw err;
    });

    expect(() =>
      wrapped?.(
        { id: "gpt-5.5", provider: "openai", api: "openai-responses" } as never,
        {
          messages: [],
        } as never,
      ),
    ).toThrow(err);

    const events = lines.map((line) => JSON.parse(line.trim()) as Record<string, unknown>);
    const errorEvent = events.find((event) => event.stage === "model:call:error") as
      | { options?: Record<string, unknown> }
      | undefined;
    expect(errorEvent?.options?.errorCategory).toBe("Error");
    expect(JSON.stringify(events)).not.toContain("secret prompt body");
    expect(JSON.stringify(events)).not.toContain("sk-secret-error-name");
  });

  it("records tool execution labels and durations without args or results", () => {
    const { lines, trace } = createMemoryTraceForTest();

    trace?.recordToolExecution({ phase: "start", toolName: "surf_ace_push" });
    trace?.recordToolExecution({
      phase: "end",
      toolName: "surf_ace_push",
      durationMs: 123.4,
      isError: false,
    });

    const events = lines.map((line) => JSON.parse(line.trim()) as Record<string, unknown>);
    expect(events.map((event) => event.stage)).toEqual([
      "tool:execution:start",
      "tool:execution:end",
    ]);
    expect(events[0]?.options).toEqual({ toolName: "surf_ace_push" });
    expect(events[1]?.options).toEqual({
      toolName: "surf_ace_push",
      durationMs: 123,
      isError: false,
    });
    expect(JSON.stringify(events)).not.toContain("args");
    expect(JSON.stringify(events)).not.toContain("result");
  });

  it("respects env overrides for enablement", () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
          },
        },
      },
      env: {
        OPENCLAW_CACHE_TRACE: "0",
      },
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });

    expect(trace).toBeNull();
  });

  it("sanitizes cache-trace payloads before writing", () => {
    const { lines, trace } = createMemoryTraceForTest();

    trace?.recordStage("stream:context", {
      system: {
        provider: { apiKey: "sk-system-secret", baseUrl: "https://api.example.com" },
      },
      model: {
        id: "test-model",
        apiKey: "sk-model-secret",
        tokenCount: 8192,
      },
      options: {
        apiKey: "sk-options-secret",
        nested: {
          password: "super-secret-password",
          safe: "keep-me",
          tokenCount: 42,
        },
        images: [{ type: "image", mimeType: "image/png", data: "QUJDRA==" }],
      },
      messages: [
        {
          role: "user",
          token: "message-secret-token",
          metadata: {
            secretKey: "message-secret-key",
            label: "preserve-me",
          },
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: "U0VDUkVU" },
            },
          ],
        },
      ] as unknown as [],
    });

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.system).toEqual({
      provider: {
        baseUrl: "https://api.example.com",
      },
    });
    expect(event.model).toEqual({
      id: "test-model",
      tokenCount: 8192,
    });
    expect(event.options).toEqual({
      nested: {
        safe: "keep-me",
        tokenCount: 42,
      },
      images: [
        {
          type: "image",
          mimeType: "image/png",
          data: "<redacted>",
          bytes: 4,
          sha256: crypto.createHash("sha256").update("QUJDRA==").digest("hex"),
        },
      ],
    });

    const optionsImages = (
      ((event.options as { images?: unknown[] } | undefined)?.images ?? []) as Array<
        Record<string, unknown>
      >
    )[0];
    expect(optionsImages?.data).toBe("<redacted>");
    expect(optionsImages?.bytes).toBe(4);
    expect(optionsImages?.sha256).toBe(
      crypto.createHash("sha256").update("QUJDRA==").digest("hex"),
    );

    const firstMessage = ((event.messages as Array<Record<string, unknown>> | undefined) ?? [])[0];
    expect(firstMessage).not.toHaveProperty("token");
    expect(firstMessage).not.toHaveProperty("metadata.secretKey");
    expect(firstMessage?.role).toBe("user");
    expect(firstMessage?.metadata).toEqual({
      label: "preserve-me",
    });
    const source = (((firstMessage?.content as Array<Record<string, unknown>> | undefined) ?? [])[0]
      ?.source ?? {}) as Record<string, unknown>;
    expect(source.data).toBe("<redacted>");
    expect(source.bytes).toBe(6);
    expect(source.sha256).toBe(crypto.createHash("sha256").update("U0VDUkVU").digest("hex"));
  });

  it("handles circular references in messages without stack overflow", () => {
    const { lines, trace } = createMemoryTraceForTest();

    const parent: Record<string, unknown> = { role: "user", content: "hello" };
    const child: Record<string, unknown> = { ref: parent };
    parent.child = child; // circular reference

    trace?.recordStage("prompt:images", {
      messages: [parent] as unknown as [],
    });

    expect(lines.length).toBe(1);
    const fingerprint = crypto
      .createHash("sha256")
      .update('{"child":{"ref":"[Circular]"},"content":"hello","role":"user"}')
      .digest("hex");
    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event).toStrictEqual({
      ts: expect.any(String),
      seq: 1,
      stage: "prompt:images",
      messageCount: 1,
      messageRoles: ["user"],
      messageFingerprints: [fingerprint],
      messagesDigest: crypto.createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex"),
      messages: [{ role: "user", content: "hello", child: { ref: "[Circular]" } }],
    });
  });
});
