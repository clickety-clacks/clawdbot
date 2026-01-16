import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { ClawdbotConfig } from "../config/config.js";
import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import type { EmbeddedPiRunResult } from "../agents/pi-embedded-runner.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded-runner.js";
import type { AdapterExecuteParams, Logger } from "./domain.js";
import { resolveClawlineConfig, type ResolvedClawlineConfig } from "./config.js";

export type AdapterResult = { exitCode: number; output: string };

export type ClawlineAdapter = {
  execute: (params: AdapterExecuteParams) => Promise<AdapterResult>;
};

type AdapterCreateParams = {
  config: ClawdbotConfig;
  statePath: string;
  logger?: Logger;
  clawlineConfig?: ResolvedClawlineConfig;
};

function extractText(result: EmbeddedPiRunResult): string | null {
  const texts =
    result.payloads
      ?.map((entry) => entry.text?.trim())
      .filter((value): value is string => Boolean(value)) ?? [];
  if (texts.length === 0) return null;
  return texts.join("\n\n");
}

export async function createClawlineAdapter(
  params: AdapterCreateParams,
): Promise<ClawlineAdapter> {
  const logger = params.logger ?? console;
  const resolved = params.clawlineConfig ?? resolveClawlineConfig(params.config);
  const adapterProvider = resolved.adapterOverrides.provider?.trim() || undefined;
  let adapterModel = resolved.adapterOverrides.model?.trim() || undefined;
  let providerOverride = adapterProvider;
  let modelOverride = adapterModel;
  if (!providerOverride && adapterModel) {
    const slash = adapterModel.indexOf("/");
    if (slash > 0 && slash < adapterModel.length - 1) {
      const provider = adapterModel.slice(0, slash).trim();
      const model = adapterModel.slice(slash + 1).trim();
      if (provider && model) {
        providerOverride = provider;
        modelOverride = model;
      }
    }
  }
  const timeoutSeconds =
    resolved.adapterOverrides.timeoutSeconds ??
    params.config.agents?.defaults?.timeoutSeconds ??
    300;
  const timeoutMs = Math.max(1, timeoutSeconds) * 1000;
  const agentId = resolveDefaultAgentId(params.config);
  const workspaceDir = resolveAgentWorkspaceDir(params.config, agentId);
  const sessionDir = path.join(params.statePath, "sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  return {
    async execute(ctx) {
      const sessionFile = path.join(sessionDir, `${ctx.userId}.jsonl`);
      await fs.mkdir(path.dirname(sessionFile), { recursive: true });
      const runId = randomUUID();
      const result = await runEmbeddedPiAgent({
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionId,
        sessionFile,
        workspaceDir,
        config: params.config,
        prompt: ctx.prompt,
        provider: providerOverride,
        model: modelOverride,
        thinkLevel: params.config.agents?.defaults?.thinkingDefault,
        timeoutMs,
        runId,
        extraSystemPrompt: resolved.adapterOverrides.systemPrompt,
        ownerNumbers: undefined,
      });
      const text = extractText(result);
      if (!text) {
        const fallback = resolved.adapterOverrides.responseFallback ?? "";
        if (!fallback) {
          logger.warn?.(
            "[clawline] adapter returned no text; consider setting clawline.adapter.responseFallback",
          );
        }
        return { exitCode: 1, output: fallback };
      }
      return { exitCode: 0, output: text };
    },
  };
}
