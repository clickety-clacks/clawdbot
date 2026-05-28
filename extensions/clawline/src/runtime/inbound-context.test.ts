import { describe, expect, it } from "vitest";
import {
  buildClawlineInboundContext,
  type BuildClawlineInboundContextParams,
} from "./inbound-context.js";

function baseParams(
  overrides: Partial<BuildClawlineInboundContextParams> = {},
): BuildClawlineInboundContextParams {
  return {
    channel: "clawline",
    accountId: "default",
    agentId: "main",
    sessionKey: "agent:main:clawline:flynn:dm",
    mainSessionKey: "agent:main:main",
    messageId: "c_1",
    rawBody: "hello",
    fromPeerId: "peer-1",
    to: "device:device-1",
    senderId: "flynn",
    senderName: "Flynn",
    nativeChannelId: "clawline:flynn:s_dm",
    originatingChannel: "clawline",
    originatingTo: "clawline:flynn:s_dm",
    ...overrides,
  };
}

describe("buildClawlineInboundContext", () => {
  it("maps Clawline text route and session facts through canonical inbound context", () => {
    const ctx = buildClawlineInboundContext(
      baseParams({
        body: "hello\n\nAttachments:\nAttachment 1: inline image (image/png, ~12 bytes)",
        commandBody: "hello",
        groupSystemPrompt: "Clawline stream guidance",
      }),
    );

    expect(ctx).toMatchObject({
      Body: "hello\n\nAttachments:\nAttachment 1: inline image (image/png, ~12 bytes)",
      RawBody: "hello",
      CommandBody: "hello",
      BodyForCommands: "hello",
      From: "clawline:peer-1",
      To: "device:device-1",
      SessionKey: "agent:main:clawline:flynn:dm",
      AccountId: "default",
      MessageSid: "c_1",
      ChatType: "direct",
      SenderName: "Flynn",
      SenderId: "flynn",
      Provider: "clawline",
      Surface: "clawline",
      NativeChannelId: "clawline:flynn:s_dm",
      OriginatingChannel: "clawline",
      OriginatingTo: "clawline:flynn:s_dm",
      GroupSystemPrompt: "Clawline stream guidance",
      CommandAuthorized: true,
    });
  });

  it("maps Clawline reply references to canonical reply id and quote fields", () => {
    const ctx = buildClawlineInboundContext(
      baseParams({
        replyReference: {
          id: "s_1",
          fullId: "agent:main:clawline:flynn:dm:s_1",
          body: "Referenced assistant answer",
          sender: "assistant",
        },
      }),
    );

    expect(ctx.ReplyToId).toBe("s_1");
    expect(ctx.ReplyToIdFull).toBe("agent:main:clawline:flynn:dm:s_1");
    expect(ctx.ReplyToBody).toBe("Referenced assistant answer");
    expect(ctx.ReplyToSender).toBe("assistant");
    expect(ctx.UntrustedStructuredContext).toBeUndefined();
  });

  it("lets explicit Clawline reply references override legacy structured contexts", () => {
    const ctx = buildClawlineInboundContext(
      baseParams({
        replyReference: {
          id: "s_explicit",
          fullId: "agent:main:clawline:flynn:dm:s_explicit",
          body: "Explicit referenced body",
          sender: "user",
        },
        referenceContexts: [
          {
            label: "Reply reference: user is replying to message s_legacy",
            source: "clawline",
            type: "reply_reference",
            payload: {
              kind: "reply",
              llm_visible_message_id: "s_legacy",
              preview: "Legacy referenced body",
              role: "assistant",
            },
          },
        ],
      }),
    );

    expect(ctx.ReplyToId).toBe("s_explicit");
    expect(ctx.ReplyToIdFull).toBe("agent:main:clawline:flynn:dm:s_explicit");
    expect(ctx.ReplyToBody).toBe("Explicit referenced body");
    expect(ctx.ReplyToSender).toBe("user");
    expect(ctx.UntrustedStructuredContext).toBeUndefined();
  });

  it("promotes existing reply reference contexts and keeps only Clawline-specific extras untrusted", () => {
    const ctx = buildClawlineInboundContext(
      baseParams({
        referenceContexts: [
          {
            label: "Reply reference: user is replying to message s_2",
            source: "clawline",
            type: "reply_reference",
            payload: {
              kind: "reply",
              llm_visible_message_id: "s_2",
              role: "assistant",
              preview: "Referenced body",
            },
          },
          {
            label: "Reply reference: user is replying to message s_3",
            source: "clawline",
            type: "reply_reference",
            payload: {
              kind: "reply",
              llm_visible_message_id: "s_3",
              preview: "Second reference",
              stream_session_key: "agent:main:clawline:flynn:dm",
            },
          },
        ],
      }),
    );

    expect(ctx.ReplyToId).toBe("s_2");
    expect(ctx.ReplyToBody).toBe("Referenced body");
    expect(ctx.ReplyToSender).toBe("assistant");
    expect(ctx.UntrustedStructuredContext).toEqual([
      {
        label: "Reply reference: user is replying to message s_3",
        source: "clawline",
        type: "reply_reference",
        payload: {
          kind: "reply",
          llm_visible_message_id: "s_3",
          preview: "Second reference",
          stream_session_key: "agent:main:clawline:flynn:dm",
        },
      },
    ]);
  });

  it("maps materialized Clawline media facts to canonical media fields", () => {
    const ctx = buildClawlineInboundContext(
      baseParams({
        media: [
          {
            path: "/Users/mike/.openclaw/clawline-media/assets/a.png",
            contentType: "image/png",
            kind: "image",
          },
          {
            url: "https://clawline.local/media/b.pdf",
            contentType: "application/pdf",
            kind: "document",
          },
        ],
      }),
    );

    expect(ctx.MediaPath).toBe("/Users/mike/.openclaw/clawline-media/assets/a.png");
    expect(ctx.MediaUrl).toBe("/Users/mike/.openclaw/clawline-media/assets/a.png");
    expect(ctx.MediaType).toBe("image/png");
    expect(ctx.MediaPaths).toEqual(["/Users/mike/.openclaw/clawline-media/assets/a.png", ""]);
    expect(ctx.MediaUrls).toEqual([
      "/Users/mike/.openclaw/clawline-media/assets/a.png",
      "https://clawline.local/media/b.pdf",
    ]);
    expect(ctx.MediaTypes).toEqual(["image/png", "application/pdf"]);
  });

  it("preserves Clawline-only supplemental context alongside canonical media", () => {
    const ctx = buildClawlineInboundContext(
      baseParams({
        media: [
          {
            url: "https://clawline.local/media/image-only.png",
            contentType: "image/png",
            kind: "image",
          },
        ],
        untrustedContext: [
          {
            label: "Clawline local asset",
            source: "clawline",
            type: "local_asset",
            payload: {
              asset_id: "asset-1",
              local_path: "/Users/mike/.openclaw/clawline-media/assets/image-only.png",
            },
          },
        ],
      }),
    );

    expect(ctx.MediaUrl).toBe("https://clawline.local/media/image-only.png");
    expect(ctx.MediaPath).toBeUndefined();
    expect(ctx.MediaTypes).toEqual(["image/png"]);
    expect(ctx.UntrustedStructuredContext).toEqual([
      {
        label: "Clawline local asset",
        source: "clawline",
        type: "local_asset",
        payload: {
          asset_id: "asset-1",
          local_path: "/Users/mike/.openclaw/clawline-media/assets/image-only.png",
        },
      },
    ]);
  });
});
