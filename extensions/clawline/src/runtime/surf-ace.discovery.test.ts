import { beforeEach, describe, expect, it, vi } from "vitest";

const { runCommandWithTimeout } = vi.hoisted(() => ({
  runCommandWithTimeout: vi.fn(),
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout,
}));

import { discoverSurfAceScreens } from "./surf-ace.js";

describe("discoverSurfAceScreens", () => {
  beforeEach(() => {
    runCommandWithTimeout.mockReset();
  });

  it("parses TXT records with backslash-escaped spaces", async () => {
    runCommandWithTimeout
      .mockResolvedValueOnce({
        stdout: "Add 2 4 local. _surf-ace._tcp. TARS\\ Surf\\ Ace\n",
      })
      .mockResolvedValueOnce({
        stdout: [
          "TARS\\ Surf\\ Ace._surf-ace._tcp.local.",
          "can be reached at 192.168.1.44:17777",
          "txt v=1 w=1920 h=1080 s=2 cap=31 busy=0 pk=6364d5a2 name=TARS\\ Surf\\ Ace",
        ].join("\n"),
      });

    const records = await discoverSurfAceScreens(1_500);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      instanceName: "TARS Surf Ace",
      host: "192.168.1.44",
      port: 17777,
      txt: expect.objectContaining({
        pk: "6364d5a2",
        name: "TARS Surf Ace",
      }),
    });
  });
});
