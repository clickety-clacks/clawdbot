import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { castAgentMessage } from "../../test-helpers/agent-message-fixtures.js";
import {
  PRUNED_HISTORY_IMAGE_MARKER,
  pruneProcessedHistoryImages,
  pruneProcessedHistoryImagesInSession,
} from "./history-image-prune.js";

describe("pruneProcessedHistoryImages", () => {
  const image: ImageContent = { type: "image", data: "abc", mimeType: "image/png" };

  it("prunes image blocks from user messages that already have assistant replies", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [{ type: "text", text: "See /tmp/photo.png" }, { ...image }],
      }),
      castAgentMessage({
        role: "assistant",
        content: "got it",
      }),
    ];

    const didMutate = pruneProcessedHistoryImages(messages);

    expect(didMutate).toBe(true);
    const firstUser = messages[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    expect(Array.isArray(firstUser?.content)).toBe(true);
    const content = firstUser?.content as Array<{ type: string; text?: string; data?: string }>;
    expect(content).toHaveLength(2);
    expect(content[0]?.type).toBe("text");
    expect(content[1]).toMatchObject({ type: "text", text: PRUNED_HISTORY_IMAGE_MARKER });
  });

  it("does not prune latest user message when no assistant response exists yet", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: [{ type: "text", text: "See /tmp/photo.png" }, { ...image }],
      }),
    ];

    const didMutate = pruneProcessedHistoryImages(messages);

    expect(didMutate).toBe(false);
    const first = messages[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    if (!first || !Array.isArray(first.content)) {
      throw new Error("expected array content");
    }
    expect(first.content).toHaveLength(2);
    expect(first.content[1]).toMatchObject({ type: "image", data: "abc" });
  });

  it("prunes image blocks from toolResult messages that already have assistant replies", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "screenshot bytes" }, { ...image }],
      }),
      castAgentMessage({
        role: "assistant",
        content: "ack",
      }),
    ];

    const didMutate = pruneProcessedHistoryImages(messages);

    expect(didMutate).toBe(true);
    const firstTool = messages[0] as Extract<AgentMessage, { role: "toolResult" }> | undefined;
    if (!firstTool || !Array.isArray(firstTool.content)) {
      throw new Error("expected toolResult array content");
    }
    expect(firstTool.content).toHaveLength(2);
    expect(firstTool.content[1]).toMatchObject({ type: "text", text: PRUNED_HISTORY_IMAGE_MARKER });
  });

  it("does not change messages when no assistant turn exists", () => {
    const messages: AgentMessage[] = [
      castAgentMessage({
        role: "user",
        content: "noop",
      }),
    ];

    const didMutate = pruneProcessedHistoryImages(messages);

    expect(didMutate).toBe(false);
    const firstUser = messages[0] as Extract<AgentMessage, { role: "user" }> | undefined;
    expect(firstUser?.content).toBe("noop");
  });

  it("durably prunes already-answered image blocks from the current session branch", () => {
    const userMessage = castAgentMessage({
      role: "user",
      content: [{ type: "text", text: "See photo" }, { ...image }],
    });
    const assistantMessage = castAgentMessage({
      role: "assistant",
      content: "got it",
    });
    const branch = [
      { type: "message" as const, id: "u1", message: userMessage },
      { type: "message" as const, id: "a1", message: assistantMessage },
    ];
    let rewriteCount = 0;

    const didMutate = pruneProcessedHistoryImagesInSession({
      getBranch: () => branch,
      getLeafId: () => "a1",
      _rewriteFile: () => {
        rewriteCount += 1;
      },
    });

    expect(didMutate).toBe(true);
    expect(rewriteCount).toBe(1);
    const firstUser = branch[0]?.message as Extract<AgentMessage, { role: "user" }> | undefined;
    if (!firstUser || !Array.isArray(firstUser.content)) {
      throw new Error("expected array content");
    }
    expect(firstUser.content[1]).toMatchObject({
      type: "text",
      text: PRUNED_HISTORY_IMAGE_MARKER,
    });
  });

  it("does not rewrite the session file when the current branch has no answered image turn", () => {
    const branch = [
      {
        type: "message" as const,
        id: "u1",
        message: castAgentMessage({
          role: "user",
          content: [{ type: "text", text: "See photo" }, { ...image }],
        }),
      },
    ];
    let rewriteCount = 0;

    const didMutate = pruneProcessedHistoryImagesInSession({
      getBranch: () => branch,
      getLeafId: () => "u1",
      _rewriteFile: () => {
        rewriteCount += 1;
      },
    });

    expect(didMutate).toBe(false);
    expect(rewriteCount).toBe(0);
  });
});
