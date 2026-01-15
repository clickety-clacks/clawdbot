import { describe, expect, it } from "vitest";

import { deepMerge } from "./deep-merge.js";

describe("deepMerge", () => {
  it("merges nested objects without touching arrays", () => {
    const target = {
      media: {
        inline: 256,
        formats: ["png"],
      },
      flag: true,
    };
    const source = {
      media: {
        inline: 128,
      },
      flag: false,
    };

    const merged = deepMerge(JSON.parse(JSON.stringify(target)), source);

    expect(merged.media.inline).toBe(128);
    expect(merged.media.formats).toEqual(["png"]);
    expect(merged.flag).toBe(false);
  });

  it("ignores undefined values", () => {
    const merged = deepMerge({ count: 1 }, { count: undefined });
    expect(merged.count).toBe(1);
  });
});
