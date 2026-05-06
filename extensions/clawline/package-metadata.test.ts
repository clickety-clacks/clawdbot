import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = __dirname;
const repoRoot = path.resolve(extensionRoot, "../..");

function readJsonFile(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readWorkspaceOnlyBuiltDependencies(): string[] {
  const workspace = fs.readFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  const lines = workspace.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === "onlyBuiltDependencies:");
  if (start < 0) {
    return [];
  }
  const values: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/u.test(line)) {
      break;
    }
    const match = /^\s*-\s+"?([^"\n]+)"?\s*$/u.exec(line);
    if (match?.[1]) {
      values.push(match[1]);
    }
  }
  return values;
}

describe("Clawline package metadata", () => {
  it("is synced to the OpenClaw v2026.5.4 plugin/runtime contract", () => {
    const manifest = readJsonFile(path.join(extensionRoot, "package.json")) as {
      version?: string;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      openclaw?: {
        install?: { minHostVersion?: string };
        compat?: { pluginApi?: string };
        build?: { openclawVersion?: string };
      };
    };

    expect(manifest.version).toBe("2026.5.4");
    expect(manifest.peerDependencies?.openclaw).toBe(">=2026.5.4");
    expect(manifest.openclaw?.install?.minHostVersion).toBe(">=2026.5.4");
    expect(manifest.openclaw?.compat?.pluginApi).toBe(">=2026.5.4");
    expect(manifest.openclaw?.build?.openclawVersion).toBe("2026.5.4");
    expect(manifest.dependencies?.["better-sqlite3"]).toBe("12.6.2");
  });

  it("keeps better-sqlite3 in pnpm's effective workspace build allowlist", () => {
    expect(readWorkspaceOnlyBuiltDependencies()).toContain("better-sqlite3");
  });

  it("can load the better-sqlite3 native runtime used by Clawline", () => {
    const db = new BetterSqlite3(":memory:");
    try {
      expect(db.prepare("select 1 as ok").get()).toEqual({ ok: 1 });
    } finally {
      db.close();
    }
  });
});
