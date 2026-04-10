import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAcpVisibleTextAccumulator,
  resolveFallbackRetryPrompt,
  sessionFileHasActivePromptBody,
} from "./attempt-execution.js";

describe("resolveFallbackRetryPrompt", () => {
  const originalBody = "Summarize the quarterly earnings report and highlight key trends.";

  it("returns original body on first attempt (isFallbackRetry=false)", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: false,
      }),
    ).toBe(originalBody);
  });

  it("returns recovery prompt for fallback retry with existing session history", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: true,
        sessionHasActiveBody: true,
      }),
    ).toBe("Continue where you left off. The previous model attempt failed or timed out.");
  });

  it("preserves original body for clawline fallback retry with session history", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: true,
        messageChannel: "clawline",
        sessionHasActiveBody: true,
      }),
    ).toBe(originalBody);
  });

  it("preserves original body for fallback retry when session has no history (subagent spawn)", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: true,
        sessionHasActiveBody: false,
      }),
    ).toBe(originalBody);
  });

  it("preserves original body for fallback retry when sessionHasActiveBody is undefined", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: true,
      }),
    ).toBe(originalBody);
  });

  it("returns original body on first attempt regardless of sessionHasActiveBody", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: false,
        sessionHasActiveBody: true,
      }),
    ).toBe(originalBody);

    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: false,
        sessionHasActiveBody: false,
      }),
    ).toBe(originalBody);
  });

  it("preserves original body on fallback retry without history", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: originalBody,
        isFallbackRetry: true,
        sessionHasActiveBody: false,
      }),
    ).toBe(originalBody);
  });
});

describe("sessionFileHasActivePromptBody", () => {
  let tmpDir: string;
  const activeBody = "Summarize the quarterly earnings report and highlight key trends.";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns false for undefined sessionFile", async () => {
    expect(await sessionFileHasActivePromptBody(undefined, activeBody)).toBe(false);
  });

  it("returns false when session file does not exist", async () => {
    expect(
      await sessionFileHasActivePromptBody(path.join(tmpDir, "nonexistent.jsonl"), activeBody),
    ).toBe(false);
  });

  it("returns false when session file is empty", async () => {
    const file = path.join(tmpDir, "empty.jsonl");
    await fs.writeFile(file, "", "utf-8");
    expect(await sessionFileHasActivePromptBody(file, activeBody)).toBe(false);
  });

  it("returns false when transcript has prior assistant history but not the active body", async () => {
    const file = path.join(tmpDir, "stale-history.jsonl");
    await fs.writeFile(
      file,
      [
        '{"type":"session","id":"s1"}',
        '{"type":"message","message":{"role":"user","content":"Earlier task"}}',
        '{"type":"message","message":{"role":"assistant","content":"Earlier answer"}}',
      ].join("\n") + "\n",
      "utf-8",
    );
    expect(await sessionFileHasActivePromptBody(file, activeBody)).toBe(false);
  });

  it("returns true when the latest user turn after the last assistant matches the active body", async () => {
    const file = path.join(tmpDir, "with-active-body.jsonl");
    await fs.writeFile(
      file,
      [
        '{"type":"session","id":"s1"}',
        '{"type":"message","message":{"role":"user","content":"Earlier task"}}',
        '{"type":"message","message":{"role":"assistant","content":"Earlier answer"}}',
        JSON.stringify({ type: "message", message: { role: "user", content: activeBody } }),
      ].join("\n") + "\n",
      "utf-8",
    );
    expect(await sessionFileHasActivePromptBody(file, activeBody)).toBe(true);
  });

  it("returns true when the active body is persisted as text blocks", async () => {
    const file = path.join(tmpDir, "text-blocks.jsonl");
    await fs.writeFile(
      file,
      [
        '{"type":"message","message":{"role":"assistant","content":"Earlier answer"}}',
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: activeBody }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8",
    );
    expect(await sessionFileHasActivePromptBody(file, activeBody)).toBe(true);
  });

  it("returns false when the matching active body was from an earlier turn", async () => {
    const file = path.join(tmpDir, "stale-active-body.jsonl");
    const bigContent = "x".repeat(300 * 1024);
    const lines =
      [
        `{"type":"session","id":"s1"}`,
        JSON.stringify({ type: "message", message: { role: "user", content: activeBody } }),
        `{"type":"message","message":{"role":"assistant","content":"done"}}`,
        `{"type":"message","message":{"role":"user","content":"${bigContent}"}}`,
      ].join("\n") + "\n";
    await fs.writeFile(file, lines, "utf-8");
    expect(await sessionFileHasActivePromptBody(file, activeBody)).toBe(false);
  });

  it("returns false when session file is a symbolic link", async () => {
    const realFile = path.join(tmpDir, "real.jsonl");
    await fs.writeFile(
      realFile,
      JSON.stringify({ type: "message", message: { role: "user", content: activeBody } }) + "\n",
      "utf-8",
    );
    const link = path.join(tmpDir, "link.jsonl");
    await fs.symlink(realFile, link);
    expect(await sessionFileHasActivePromptBody(link, activeBody)).toBe(false);
  });
});

describe("createAcpVisibleTextAccumulator", () => {
  it("preserves cumulative raw snapshots after stripping a glued NO_REPLY prefix", () => {
    const acc = createAcpVisibleTextAccumulator();

    expect(acc.consume("NO_REPLYThe user")).toEqual({
      text: "The user",
      delta: "The user",
    });

    expect(acc.consume("NO_REPLYThe user is saying")).toEqual({
      text: "The user is saying",
      delta: " is saying",
    });

    expect(acc.finalize()).toBe("The user is saying");
    expect(acc.finalizeRaw()).toBe("The user is saying");
  });

  it("keeps append-only deltas working after stripping a glued NO_REPLY prefix", () => {
    const acc = createAcpVisibleTextAccumulator();

    expect(acc.consume("NO_REPLYThe user")).toEqual({
      text: "The user",
      delta: "The user",
    });

    expect(acc.consume(" is saying")).toEqual({
      text: "The user is saying",
      delta: " is saying",
    });
  });

  it("preserves punctuation-start text that begins with NO_REPLY-like content", () => {
    const acc = createAcpVisibleTextAccumulator();

    expect(acc.consume("NO_REPLY: explanation")).toEqual({
      text: "NO_REPLY: explanation",
      delta: "NO_REPLY: explanation",
    });

    expect(acc.finalize()).toBe("NO_REPLY: explanation");
  });
});
