import type { ImageContent } from "@mariozechner/pi-ai";
import type { NormalizedAttachment } from "./domain.js";

type AssetImageLoadResult = {
  data: string;
  mimeType: string;
};

type AttachmentToImageOptions = {
  loadAssetImage?: (assetId: string) => Promise<AssetImageLoadResult | null>;
};

export async function clawlineAttachmentsToImages(
  attachments: NormalizedAttachment[],
  options: AttachmentToImageOptions = {},
): Promise<ImageContent[]> {
  if (!attachments || attachments.length === 0) {
    return [];
  }
  const images: ImageContent[] = [];
  for (const attachment of attachments) {
    if (!attachment) {
      continue;
    }
    if (attachment.type === "image") {
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
      continue;
    }
    if (attachment.type === "asset" && options.loadAssetImage) {
      const loaded = await options.loadAssetImage(attachment.assetId);
      const data = typeof loaded?.data === "string" ? loaded.data.trim() : "";
      const mimeType = typeof loaded?.mimeType === "string" ? loaded.mimeType.trim() : "";
      if (!data || !mimeType) {
        continue;
      }
      images.push({
        type: "image",
        data,
        mimeType,
      });
    }
  }
  return images;
}
