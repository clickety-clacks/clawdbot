import { describe, expect, it } from "vitest";
import { ClawlineConfigSchema } from "./config-schema.js";

describe("ClawlineConfigSchema", () => {
  it("accepts stream Phase A limits", () => {
    const parsed = ClawlineConfigSchema.parse({
      server: {
        cluSecret: "clu-secret-1",
      },
      streams: {
        maxStreamsPerUser: 32,
        maxDisplayNameBytes: 120,
      },
      sessions: {
        maxReplayMessagesPerStream: 20,
      },
    });

    expect(parsed.server?.cluSecret).toBe("clu-secret-1");
    expect(parsed.streams?.maxStreamsPerUser).toBe(32);
    expect(parsed.streams?.maxDisplayNameBytes).toBe(120);
    expect(parsed.sessions?.maxReplayMessagesPerStream).toBe(20);
  });

  it("rejects non-phaseA built-in rename/delete flags", () => {
    expect(() =>
      ClawlineConfigSchema.parse({
        streams: {
          allowBuiltInRename: true,
        },
      }),
    ).toThrow();
  });

  it("accepts server.cluSecret for CLU-secret auth (T140 follow-up)", () => {
    const parsed = ClawlineConfigSchema.parse({
      server: {
        cluSecret: "my-secret-at-least-22chars!!",
      },
    });
    expect(parsed.server?.cluSecret).toBe("my-secret-at-least-22chars!!");
  });

  it("accepts server.cluSecret as null (disables CLU-secret path)", () => {
    const parsed = ClawlineConfigSchema.parse({ server: { cluSecret: null } });
    expect(parsed.server?.cluSecret).toBeNull();
  });

  it("accepts terminal tmux config for current runtime compatibility", () => {
    const parsed = ClawlineConfigSchema.parse({
      terminal: {
        tmux: {
          mode: "ssh",
          ssh: {
            target: "mike@eezo",
            identityFile: "/Users/mike/.ssh/id_ed25519_clu",
            port: 22,
            knownHostsFile: "/Users/mike/.ssh/known_hosts",
            strictHostKeyChecking: "accept-new",
            extraArgs: ["-o", "IdentitiesOnly=yes"],
          },
        },
      },
    });

    expect(parsed.terminal?.tmux?.mode).toBe("ssh");
    expect(parsed.terminal?.tmux?.ssh?.target).toBe("mike@eezo");
  });

  it("rejects unknown keys inside server block", () => {
    expect(() =>
      ClawlineConfigSchema.parse({
        server: { unknownKey: true },
      }),
    ).toThrow();
  });
});
