import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadSessionStore } from "../config/sessions.js";
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
    expect(entry.sessionFile).toBe("/tmp/clawline-session.jsonl");
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

  it("sets lastTo when userId is provided", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawline-session-lastto-"));
    const storePath = path.join(dir, "sessions.json");
    const sessionKey = "clawline:user:device";

    await recordClawlineSessionActivity({
      storePath,
      sessionKey,
      sessionId: "session_2",
      displayName: "Bob",
      userId: "bob123",
    });

    const store = loadSessionStore(storePath);
    const entry = store[sessionKey];
    expect(entry).toBeDefined();
    expect(entry.lastTo).toBe("bob123");
    expect(entry.lastChannel).toBe("clawline");
  });
});
