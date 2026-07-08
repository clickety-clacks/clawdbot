// Control UI chat image attachment preparation keeps user uploads under model image limits.
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";

type ParsedDataUrl = {
  content: string;
  mimeType: string;
};

type ImageScaleTarget = {
  height: number;
  width: number;
};

const MIN_IMAGE_DIMENSION = 512;
const INITIAL_JPEG_QUALITY = 0.9;
const MIN_JPEG_QUALITY = 0.58;
const QUALITY_STEP = 0.08;
const RESIZE_STEP = 0.85;
const DOWNSCALE_PASS_LIMIT = 12;
const MODEL_AWARE_MAX_IMAGE_DIMENSION = 1568;

let prepareImageDataUrlForChatSendOverride:
  | ((dataUrl: string) => Promise<string | undefined>)
  | undefined;

export function parseChatAttachmentDataUrl(dataUrl: string): ParsedDataUrl | null {
  const match = /^data:([^;]+);base64,(.+)$/u.exec(dataUrl);
  if (!match) {
    return null;
  }
  return { mimeType: match[1], content: match[2] };
}

export function base64ByteLength(content: string): number {
  const normalized = content.replace(/\s+/gu, "");
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

export async function prepareImageDataUrlForChatSend(dataUrl: string): Promise<string> {
  const override = prepareImageDataUrlForChatSendOverride;
  if (override) {
    const prepared = await override(dataUrl);
    if (prepared) {
      return prepared;
    }
    return ensureOversizedImageDoesNotPassThrough(dataUrl);
  }
  const parsed = parseChatAttachmentDataUrl(dataUrl);
  if (!parsed?.mimeType.toLowerCase().startsWith("image/")) {
    return dataUrl;
  }
  if (base64ByteLength(parsed.content) <= MAX_IMAGE_BYTES) {
    return dataUrl;
  }
  return (await downscaleImageDataUrl(dataUrl)) ?? rejectOversizedImageAttachment();
}

export function setPrepareImageDataUrlForChatSendForTest(
  prepare: ((dataUrl: string) => Promise<string | undefined>) | undefined,
): void {
  prepareImageDataUrlForChatSendOverride = prepare;
}

function ensureOversizedImageDoesNotPassThrough(dataUrl: string): string {
  const parsed = parseChatAttachmentDataUrl(dataUrl);
  if (
    parsed?.mimeType.toLowerCase().startsWith("image/") &&
    base64ByteLength(parsed.content) > MAX_IMAGE_BYTES
  ) {
    return rejectOversizedImageAttachment();
  }
  return dataUrl;
}

function rejectOversizedImageAttachment(): never {
  throw new Error("Image attachment is too large to send after preparation.");
}

function scaledSize(source: ImageScaleTarget, maxDimension: number): ImageScaleTarget {
  const scale =
    source.width > source.height
      ? source.width > maxDimension
        ? maxDimension / source.width
        : 1
      : source.height > maxDimension
        ? maxDimension / source.height
        : 1;
  return {
    height: Math.round(source.height * scale),
    width: Math.round(source.width * scale),
  };
}

async function downscaleImageDataUrl(dataUrl: string): Promise<string | undefined> {
  if (typeof Image !== "function" || typeof document === "undefined") {
    return undefined;
  }
  const image = await loadImage(dataUrl);
  let maxDimension = MODEL_AWARE_MAX_IMAGE_DIMENSION;
  let quality = INITIAL_JPEG_QUALITY;
  let pass = 0;

  while (pass < DOWNSCALE_PASS_LIMIT) {
    pass += 1;
    const candidate = renderImageAsJpegDataUrl(image, scaledSize(image, maxDimension), quality);
    const parsed = parseChatAttachmentDataUrl(candidate);
    if (parsed && base64ByteLength(parsed.content) <= MAX_IMAGE_BYTES) {
      return candidate;
    }
    if (quality > MIN_JPEG_QUALITY) {
      quality -= QUALITY_STEP;
    } else {
      maxDimension *= RESIZE_STEP;
      quality = INITIAL_JPEG_QUALITY;
    }
    if (maxDimension < MIN_IMAGE_DIMENSION) {
      break;
    }
  }
  return undefined;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("image attachment decode failed"));
    image.src = dataUrl;
  });
}

function renderImageAsJpegDataUrl(
  image: HTMLImageElement,
  size: ImageScaleTarget,
  quality: number,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("image attachment canvas unavailable");
  }
  context.drawImage(image, 0, 0, size.width, size.height);
  return canvas.toDataURL("image/jpeg", quality);
}
