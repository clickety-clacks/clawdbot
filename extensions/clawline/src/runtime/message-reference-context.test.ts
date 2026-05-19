import { describe, expect, it } from "vitest";
import {
  resolveClawlineMessageReferenceContexts,
  type ClawlineTranscriptMessageRecord,
} from "./message-reference-context.js";

describe("resolveClawlineMessageReferenceContexts", () => {
  const sessionKey = "agent:main:clawline:flynn:main";

  it("resolves a transcript message into model-visible structured context", async () => {
    const transcriptMessages: ClawlineTranscriptMessageRecord[] = [
      {
        id: "m_1",
        timestamp: 1_700_000_000_000,
        message: {
          role: "assistant",
          content: "This is the referenced body.",
        },
      },
    ];

    const result = await resolveClawlineMessageReferenceContexts({
      references: [
        {
          kind: "message",
          sessionKey,
          messageId: "m_1",
          messageRole: "assistant",
          createdAt: 1_700_000_000_000,
          clientMessageId: "c_1",
        },
      ],
      resolveTranscriptMessages: async () => transcriptMessages,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }

    expect(result.contexts).toEqual([
      {
        label: "Referenced message",
        source: "clawline",
        type: "message_reference",
        payload: {
          session_key: sessionKey,
          message_id: "m_1",
          client_message_id: "c_1",
          message_role: "assistant",
          created_at_ms: 1_700_000_000_000,
          body: "This is the referenced body.",
        },
      },
    ]);
  });

  it("fails when the referenced message cannot be resolved", async () => {
    const result = await resolveClawlineMessageReferenceContexts({
      references: [
        {
          kind: "message",
          sessionKey,
          messageId: "missing",
          messageRole: "assistant",
          createdAt: 1_700_000_000_000,
        },
      ],
      resolveTranscriptMessages: async () => [
        {
          id: "other",
          timestamp: 1_700_000_000_100,
          message: {
            role: "assistant",
            content: "Something else",
          },
        },
      ],
    });

    expect(result).toEqual({
      ok: false,
      code: "unresolved_reference",
      message: "Referenced message is unavailable.",
    });
  });

  it("fails when the reference shape is invalid", async () => {
    const result = await resolveClawlineMessageReferenceContexts({
      references: [{ kind: "message", sessionKey, messageId: "m_1" }],
      resolveTranscriptMessages: async () => [],
    });

    expect(result).toEqual({
      ok: false,
      code: "invalid_message",
      message: "Invalid reference",
    });
  });

  it("fails when the resolved transcript identity does not match", async () => {
    const result = await resolveClawlineMessageReferenceContexts({
      references: [
        {
          kind: "message",
          sessionKey,
          messageId: "m_1",
          messageRole: "assistant",
          createdAt: 1_700_000_000_000,
          clientMessageId: "c_1",
        },
      ],
      resolveTranscriptMessages: async () => [
        {
          id: "m_1",
          clientMessageId: "c_other",
          timestamp: 1_700_000_000_000,
          message: {
            role: "assistant",
            content: "This should not resolve.",
          },
        },
      ],
    });

    expect(result).toEqual({
      ok: false,
      code: "unresolved_reference",
      message: "Referenced message is unavailable.",
    });
  });
});
