import { describe, expect, it } from "vitest";
import { clawlineAttachmentsToImages } from "./attachments.js";

describe("clawlineAttachmentsToImages", () => {
  it("maps inline image attachments to image content", async () => {
    const images = await clawlineAttachmentsToImages([
      { type: "image", mimeType: "image/jpeg", data: "abcd" },
    ]);
    expect(images).toEqual([{ type: "image", mimeType: "image/jpeg", data: "abcd" }]);
  });

  it("maps asset image attachments via loader", async () => {
    const images = await clawlineAttachmentsToImages(
      [{ type: "asset", assetId: "a_test" }],
      {
        loadAssetImage: async (assetId) =>
          assetId === "a_test" ? { mimeType: "image/png", data: "ZXhhbXBsZQ==" } : null,
      },
    );
    expect(images).toEqual([{ type: "image", mimeType: "image/png", data: "ZXhhbXBsZQ==" }]);
  });

  it("drops non-image attachments and missing data", async () => {
    const images = await clawlineAttachmentsToImages([
      { type: "asset", assetId: "a_test" },
      { type: "image", mimeType: "image/png", data: "" },
    ]);
    expect(images).toEqual([]);
  });
});
