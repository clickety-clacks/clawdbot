import {
  loadWebMedia,
  sendClawlineOutboundMessage,
  type ChannelOutboundAdapter,
} from "openclaw/plugin-sdk";

function chunkTextForClawline(text: string, limit: number): string[] {
  if (!text) {
    return [];
  }
  if (limit <= 0 || text.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const lastNewline = window.lastIndexOf("\n");
    const lastSpace = window.lastIndexOf(" ");
    let breakIdx = lastNewline > 0 ? lastNewline : lastSpace;
    if (breakIdx <= 0) {
      breakIdx = limit;
    }
    const rawChunk = remaining.slice(0, breakIdx);
    const chunk = rawChunk.trimEnd();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    const brokeOnSeparator = breakIdx < remaining.length && /\s/.test(remaining[breakIdx]);
    const nextStart = Math.min(remaining.length, breakIdx + (brokeOnSeparator ? 1 : 0));
    remaining = remaining.slice(nextStart).trimStart();
  }
  if (remaining.length) {
    chunks.push(remaining);
  }
  return chunks;
}

export const clawlineOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkTextForClawline,
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
  sendText: async ({ to, text, sessionKey }) => {
    const result = await sendClawlineOutboundMessage({ target: to, text, sessionKey });
    return {
      channel: "clawline",
      messageId: result.messageId,
      meta: {
        userId: result.userId,
        deviceId: result.deviceId,
      },
    };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, sessionKey }) => {
    if (!mediaUrl) {
      throw new Error("Clawline outbound media delivery requires mediaUrl");
    }
    const maxBytes = cfg.channels?.clawline?.media?.maxUploadBytes;
    const media = await loadWebMedia(mediaUrl, maxBytes);
    const attachments = [
      {
        data: media.buffer.toString("base64"),
        mimeType: media.contentType ?? "application/octet-stream",
      },
    ];
    const result = await sendClawlineOutboundMessage({
      target: to,
      text: text ?? "",
      attachments,
      sessionKey,
    });
    return {
      channel: "clawline",
      messageId: result.messageId,
      meta: {
        userId: result.userId,
        deviceId: result.deviceId,
        assetIds: result.assetIds,
      },
    };
  },
};
