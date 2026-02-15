import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSessionStore, resolveSessionTranscriptPath } from "../config/sessions.js";
import { recordClawlineSessionActivity } from "./session-store.js";

describe("recordClawlineSessionActivity", () => {
  it("creates and updates session entries with clawline metadata", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawline-session-store-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionKey = "clawline:user:device";

    await recordClawlineSessionActivity({
      storePath,
      sessionKey,
      sessionId: "session_1",
      sessionFile: "/tmp/clawline-session.jsonl",
      displayName: "Alice",
    });

    const initialStore = loadSessionStore(storePath);
    const entry = initialStore[sessionKey];
    expect(entry).toBeDefined();
    expect(entry.channel).toBe("clawline");
    expect(entry.chatType).toBe("direct");
    expect(entry.displayName).toBe("Alice");
    expect(entry.label).toBe("Alice");
    expect(entry.sessionFile).toBe(resolveSessionTranscriptPath("session_1", "main"));
    expect(entry.sessionId).toBe("session_1");
    expect(entry.lastChannel).toBe("clawline");
    const firstUpdatedAt = entry.updatedAt;

    await recordClawlineSessionActivity({
      storePath,
      sessionKey,
      sessionId: "session_1",
      displayName: "Alice Cooper",
    });

    const updatedStore = loadSessionStore(storePath);
    const updatedEntry = updatedStore[sessionKey];
    expect(updatedEntry.displayName).toBe("Alice Cooper");
    expect(updatedEntry.label).toBe("Alice Cooper");
    expect(updatedEntry.updatedAt).toBeGreaterThanOrEqual(firstUpdatedAt);
  });

  it("preserves in-dir transcript binding across reconnect activity", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawline-session-stable-binding-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionKey = "agent:main:clawline:flynn:main";
    const initialSessionFile = resolveSessionTranscriptPath("session_first", "main");

    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId: "session_first",
            sessionFile: initialSessionFile,
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    await recordClawlineSessionActivity({
      storePath,
      sessionKey,
      sessionId: "session_second",
      sessionFile: "/tmp/transcript-second.jsonl",
      displayName: "Main",
    });

    const store = loadSessionStore(storePath);
    const entry = store[sessionKey];
    expect(entry).toBeDefined();
    expect(entry.sessionId).toBe("session_first");
    expect(entry.sessionFile).toBe(initialSessionFile);
  });

  it("repairs legacy clawdbot session file path to canonical sessions dir", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawline-session-repair-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionKey = "agent:main:clawline:flynn:main";
    const sessionId = "session_legacy";

    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId,
            sessionFile:
              "/Users/mike/.clawdbot/clawline/sessions/agent-main-clawline-flynn-main.jsonl",
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    await recordClawlineSessionActivity({
      storePath,
      sessionKey,
      sessionId,
      displayName: "Main",
    });

    const store = loadSessionStore(storePath);
    const entry = store[sessionKey];
    expect(entry).toBeDefined();
    expect(entry.sessionFile).toBe(resolveSessionTranscriptPath(sessionId, "main"));
  });

  it("does not set lastTo on connect", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawline-session-lastto-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionKey = "clawline:user:device";

    await recordClawlineSessionActivity({
      storePath,
      sessionKey,
      sessionId: "session_2",
      displayName: "Bob",
    });

    const store = loadSessionStore(storePath);
    const entry = store[sessionKey];
    expect(entry).toBeDefined();
    expect(entry.lastTo).toBeUndefined();
    expect(entry.lastChannel).toBe("clawline");
  });
});
