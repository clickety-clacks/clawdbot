import {
  createAttachedChannelResultAdapter,
  type ChannelOutboundAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import { sendClawlineOutboundMessage } from "./runtime/outbound.js";

export const clawlineOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkTextForOutbound,
  textChunkLimit: 4000,
  resolveTarget: ({ to }) => {
    const trimmed = to?.trim();
    if (!trimmed) {
      return {
        ok: false,
        error: new Error(
          "Delivering to clawline requires --to <userId|deviceId> (use device:ID to force device targeting)",
        ),
      };
    }
    return { ok: true, to: trimmed };
  },
  ...createAttachedChannelResultAdapter({
    channel: "clawline",
    sendText: async ({ to, text }) => {
      const result = await sendClawlineOutboundMessage({ target: to, text });
      return {
        messageId: result.messageId,
        meta: {
          userId: result.userId,
          deviceId: result.deviceId,
        },
      };
    },
    sendMedia: async ({ to, text, mediaUrl }) => {
      if (!mediaUrl) {
        throw new Error("Clawline outbound media delivery requires mediaUrl");
      }
      const result = await sendClawlineOutboundMessage({
        target: to,
        text: text ?? "",
        mediaUrl,
      });
      return {
        messageId: result.messageId,
        meta: {
          userId: result.userId,
          deviceId: result.deviceId,
          assetIds: result.assetIds,
        },
      };
    },
  }),
};
