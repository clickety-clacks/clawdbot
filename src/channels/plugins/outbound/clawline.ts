import { chunkText } from "../../../auto-reply/chunk.js";
import { sendClawlineOutboundMessage } from "../../../clawline/outbound.js";
import type { ChannelOutboundAdapter } from "../types.js";

export const clawlineOutbound: ChannelOutboundAdapter = {
  deliveryMode: "gateway",
  chunker: chunkText,
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
  sendText: async ({ to, text }) => {
    const result = await sendClawlineOutboundMessage({ target: to, text });
    return {
      channel: "clawline",
      messageId: result.messageId,
      meta: {
        userId: result.userId,
        deviceId: result.deviceId,
      },
    };
  },
  sendMedia: async () => {
    throw new Error("Clawline outbound media delivery is not supported yet");
  },
};
