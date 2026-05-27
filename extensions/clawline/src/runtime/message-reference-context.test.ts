import { describe, expect, it } from "vitest";
import { resolveClawlineMessageReferenceContexts } from "./message-reference-context.js";

describe("resolveClawlineMessageReferenceContexts", () => {
  it("passes an LLM-visible reply id through as model-visible structured context", async () => {
    const result = await resolveClawlineMessageReferenceContexts({
      references: [
        {
          kind: "reply",
          llmVisibleMessageId: "s_1",
          role: "assistant",
          preview: "This is the referenced body.",
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.message);
    }

    expect(result.contexts).toEqual([
      {
        label: "Reply reference: user is replying to message s_1",
        source: "clawline",
        type: "reply_reference",
        payload: {
          kind: "reply",
          llm_visible_message_id: "s_1",
          role: "assistant",
          preview: "This is the referenced body.",
        },
      },
    ]);
  });

  it("fails when the references field is not an array", async () => {
    const result = await resolveClawlineMessageReferenceContexts({
      references: "bad",
    });

    expect(result).toEqual({
      ok: false,
      code: "invalid_message",
      message: "Invalid reference",
    });
  });

  it("rejects legacy hydrated message references on the send hot path", async () => {
    const result = await resolveClawlineMessageReferenceContexts({
      references: [
        {
          kind: "message",
          sessionKey: "agent:main:clawline:flynn:main",
          messageId: "m_1",
        },
      ],
    });

    expect(result).toEqual({
      ok: false,
      code: "invalid_message",
      message: "Invalid reference",
    });
  });
});
