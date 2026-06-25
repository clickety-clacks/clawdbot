import {
  createAttachedChannelResultAdapter,
  type ChannelOutboundAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import type { ClawlineOutboundAttachmentInput } from "./runtime/domain.js";
import { sendClawlineOutboundMessage } from "./runtime/outbound.js";

type InlineImageExtraction = {
  text: string;
  attachmentText: string;
  attachments: ClawlineOutboundAttachmentInput[];
};

type InlineImageMatch = {
  start: number;
  end: number;
  mimeType: string;
  data: string;
};

type MarkdownImageCandidate = {
  start: number;
  end: number;
  mimeType: string;
  payload: string;
};

const MARKDOWN_INLINE_IMAGE_DATA_URL_PATTERN =
  /!\[[^\]]*\]\((data:(image\/[A-Za-z0-9.+-]+)(?:;[^,)]*)?;base64,([\s\S]*?))(?:\s+"[^"]*")?\)/gi;
const BARE_IMAGE_DATA_URL_PATTERN =
  /data:(image\/[A-Za-z0-9.+-]+)(?:;[^,\s)]*)?;base64,([A-Za-z0-9+/=]+(?:[ \t]*\r?\n[ \t]*[A-Za-z0-9+/=]+)*)/gi;

function isStrictBase64(data: string): boolean {
  return data.length > 0 && data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data);
}

function pushValidInlineImageMatch(
  matches: InlineImageMatch[],
  start: number,
  end: number,
  mimeType: string,
  payload: string,
): void {
  const compactData = payload.replace(/\s+/g, "");
  if (!isStrictBase64(compactData)) {
    return;
  }
  matches.push({
    start,
    end,
    mimeType: mimeType.toLowerCase(),
    data: compactData,
  });
}

function hasBareDataUrlBoundary(text: string, end: number): boolean {
  const suffix = text.slice(end);
  return suffix.length === 0 || /^[ \t]*(?:\r?\n|$)/.test(suffix);
}

function overlapsInlineImageMatch(
  matches: InlineImageMatch[],
  start: number,
  end: number,
): boolean {
  return matches.some((match) => start < match.end && end > match.start);
}

function overlapsMarkdownImageCandidate(
  candidates: MarkdownImageCandidate[],
  start: number,
  end: number,
): boolean {
  return candidates.some((candidate) => start < candidate.end && end > candidate.start);
}

function collectInlineImageMatches(text: string): InlineImageMatch[] {
  const matches: InlineImageMatch[] = [];
  const markdownCandidates: MarkdownImageCandidate[] = [];
  for (const match of text.matchAll(MARKDOWN_INLINE_IMAGE_DATA_URL_PATTERN)) {
    const start = match.index;
    const full = match[0];
    const mimeType = match[2];
    const payload = match[3];
    if (start === undefined || !mimeType || !payload) {
      continue;
    }
    markdownCandidates.push({ start, end: start + full.length, mimeType, payload });
    pushValidInlineImageMatch(matches, start, start + full.length, mimeType, payload);
  }
  for (const match of text.matchAll(BARE_IMAGE_DATA_URL_PATTERN)) {
    const start = match.index;
    const full = match[0];
    const mimeType = match[1];
    const payload = match[2];
    if (start === undefined || !mimeType || !payload) {
      continue;
    }
    const end = start + full.length;
    if (
      !hasBareDataUrlBoundary(text, end) ||
      overlapsInlineImageMatch(matches, start, end) ||
      overlapsMarkdownImageCandidate(markdownCandidates, start, end)
    ) {
      continue;
    }
    pushValidInlineImageMatch(matches, start, end, mimeType, payload);
  }
  return matches.toSorted((left, right) => left.start - right.start);
}

function removeMatchedRanges(text: string, matches: InlineImageMatch[]): string {
  let cursor = 0;
  let nextText = "";
  for (const match of matches) {
    nextText += text.slice(cursor, match.start);
    cursor = match.end;
  }
  nextText += text.slice(cursor);
  return nextText
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractInlineImageAttachments(text: string): InlineImageExtraction | null {
  const matches = collectInlineImageMatches(text);
  if (matches.length === 0) {
    return null;
  }
  return {
    text: removeMatchedRanges(text, matches),
    attachmentText: matches.map((match) => text.slice(match.start, match.end)).join("\n\n"),
    attachments: matches.map((match) => ({
      mimeType: match.mimeType,
      data: match.data,
    })),
  };
}

function chunkClawlineOutboundText(text: string, limit: number): string[] {
  // Inline generated images are binary payloads wearing a text transport. Keep the
  // attachment marker with the first chunk so sendText can lift it into native
  // Clawline attachments before the generic prose chunker can split its base64.
  const extracted = extractInlineImageAttachments(text);
  if (extracted) {
    const proseChunks = extracted.text ? chunkTextForOutbound(extracted.text, limit) : [];
    if (proseChunks.length === 0) {
      return [extracted.attachmentText];
    }
    const firstChunk = `${proseChunks[0]}\n\n${extracted.attachmentText}`.trim();
    return [firstChunk, ...proseChunks.slice(1)];
  }
  return chunkTextForOutbound(text, limit);
}

export const clawlineOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkClawlineOutboundText,
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
      const extracted = extractInlineImageAttachments(text);
      const result = await sendClawlineOutboundMessage({
        target: to,
        text: extracted?.text ?? text,
        attachments: extracted?.attachments,
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
