import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { ClawdbotConfig } from "../config/config.js";
import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  buildModelAliasIndex,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../agents/model-selection.js";
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
  const aliasIndex = buildModelAliasIndex({
    cfg: params.config,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const adapterOverride = resolved.adapterOverrides.model?.trim();
  let providerName: string;
  let modelName: string;
  if (adapterOverride) {
    const overrideRef = resolveModelRefFromString({
      raw: adapterOverride,
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex,
    });
    if (!overrideRef) {
      throw new Error(
        `Invalid clawline.adapter.model "${adapterOverride}"; expected provider/model or alias`,
      );
    }
    providerName = resolved.adapterOverrides.provider ?? overrideRef.ref.provider;
    modelName = overrideRef.ref.model;
  } else {
    const configuredRef = resolveConfiguredModelRef({
      cfg: params.config,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
    if (
      !params.config.agents?.defaults?.model?.primary &&
      !params.config.agents?.defaults?.model
    ) {
      logger.warn?.(
        "[clawline] agents.defaults.model.primary missing; using default anthropic/claude-opus-4-5",
      );
    }
    providerName = resolved.adapterOverrides.provider ?? configuredRef.provider;
    modelName = configuredRef.model;
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
        provider: providerName,
        model: modelName,
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
