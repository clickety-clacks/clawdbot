import type { ImageContent } from "@mariozechner/pi-ai";

import type { NormalizedAttachment } from "./domain.js";

export function clawlineAttachmentsToImages(attachments: NormalizedAttachment[]): ImageContent[] {
  if (!attachments || attachments.length === 0) {
    return [];
  }
  const images: ImageContent[] = [];
  for (const attachment of attachments) {
    if (!attachment || attachment.type !== "image") {
      continue;
    }
    const data = typeof attachment.data === "string" ? attachment.data.trim() : "";
    const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType.trim() : "";
    if (!data || !mimeType) {
      continue;
    }
    images.push({
      type: "image",
      data,
      mimeType,
    });
  }
  return images;
}
