import { describe, expect, it } from "vitest";
import { clawlineAttachmentsToImages } from "./attachments.js";

describe("clawlineAttachmentsToImages", () => {
  it("maps inline image attachments to image content", () => {
    const images = clawlineAttachmentsToImages([
      { type: "image", mimeType: "image/jpeg", data: "abcd" },
    ]);
    expect(images).toEqual([{ type: "image", mimeType: "image/jpeg", data: "abcd" }]);
  });

  it("drops non-image attachments and missing data", () => {
    const images = clawlineAttachmentsToImages([
      { type: "asset", assetId: "a_test" },
      { type: "image", mimeType: "image/png", data: "" },
    ]);
    expect(images).toEqual([]);
  });
});
