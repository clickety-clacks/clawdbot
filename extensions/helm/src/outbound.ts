import {
  sendHelmRequest,
  createVisualizeRequestFromMessage,
  type ChannelOutboundAdapter,
} from "clawdbot/plugin-sdk";

export const helmOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  textChunkLimit: 4000,
  resolveTarget: ({ to }) => {
    const trimmed = to?.trim();
    if (!trimmed) {
      return {
        ok: false,
        error: new Error(
          "Delivering to helm requires --to <userId> (target user with connected Helm device)",
        ),
      };
    }
    return { ok: true, to: trimmed };
  },
  sendText: async ({ to, text }) => {
    // Parse the text as a visualization request
    // The text is the content to visualize
    const request = createVisualizeRequestFromMessage({ content: text });

    const result = await sendHelmRequest({
      userId: to,
      request,
    });

    if (!result.ok) {
      throw new Error(result.error ?? "Failed to send to Helm device");
    }

    return {
      channel: "helm",
      messageId: request.id,
      meta: {
        deviceCount: result.deviceCount,
        vizId: request.id,
      },
    };
  },
  // Helm doesn't support media attachments in the traditional sense
  // Media would be embedded in the visualization context
  sendMedia: async ({ to, text }) => {
    // For media, we still create a visualization request
    // The media URL could be included in the context if needed
    const content = text ?? "Visualization request";
    const request = createVisualizeRequestFromMessage({ content });

    const result = await sendHelmRequest({
      userId: to,
      request,
    });

    if (!result.ok) {
      throw new Error(result.error ?? "Failed to send to Helm device");
    }

    return {
      channel: "helm",
      messageId: request.id,
      meta: {
        deviceCount: result.deviceCount,
        vizId: request.id,
      },
    };
  },
};
