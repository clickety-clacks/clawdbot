import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { ClawdbotConfig } from "../config/config.js";
import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { runCliAgent } from "../agents/cli-runner.js";
import { isCliProvider } from "../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import type { EmbeddedPiRunResult } from "../agents/pi-embedded-runner.js";
import type { AdapterExecuteParams, Logger } from "./server.js";
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

function parseModelRef(
  ref?: string | null,
): { provider: string; model: string } | null {
  if (!ref) return null;
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const [provider, ...rest] = trimmed.split("/");
  if (!provider || rest.length === 0) return null;
  return { provider, model: rest.join("/") };
}

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
  const defaultModelRef =
    resolved.adapterOverrides.model ??
    params.config.agents?.defaults?.model?.primary;
  const parsedModel = parseModelRef(defaultModelRef);
  if (!parsedModel) {
    throw new Error(
      "Clawline adapter requires agents.defaults.model.primary in config",
    );
  }
  const providerName =
    resolved.adapterOverrides.provider ?? parsedModel.provider;
  const timeoutSeconds =
    resolved.adapterOverrides.timeoutSeconds ??
    params.config.agents?.defaults?.timeoutSeconds ??
    300;
  const timeoutMs = Math.max(1, timeoutSeconds) * 1000;
  const agentId = resolveDefaultAgentId(params.config);
  const workspaceDir = resolveAgentWorkspaceDir(params.config, agentId);
  const sessionDir = path.join(params.statePath, "sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  const cliSessionIds = new Map<string, string | undefined>();
  const useCliBackend = isCliProvider(providerName, params.config);

  return {
    async execute(ctx) {
      const sessionFile = path.join(sessionDir, `${ctx.userId}.jsonl`);
      await fs.mkdir(path.dirname(sessionFile), { recursive: true });
      const runId = randomUUID();
      if (useCliBackend) {
        const cliSessionId = cliSessionIds.get(ctx.userId);
        const result = await runCliAgent({
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionId,
          sessionFile,
          workspaceDir,
          config: params.config,
          prompt: ctx.prompt,
          provider: providerName,
          model: parsedModel.model,
          thinkLevel: params.config.agents?.defaults?.thinkingDefault,
          timeoutMs,
          runId,
          extraSystemPrompt: resolved.adapterOverrides.systemPrompt,
          ownerNumbers: undefined,
          cliSessionId,
        });
        const newSessionId = result.meta.agentMeta?.sessionId;
        if (newSessionId) {
          cliSessionIds.set(ctx.userId, newSessionId);
        }
        return formatResult(result);
      }
      const embeddedResult = await runEmbeddedPiAgent({
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionId,
        sessionFile,
        workspaceDir,
        config: params.config,
        prompt: ctx.prompt,
        provider: providerName,
        model: parsedModel.model,
        thinkLevel: params.config.agents?.defaults?.thinkingDefault,
        timeoutMs,
        runId,
        extraSystemPrompt: resolved.adapterOverrides.systemPrompt,
        ownerNumbers: undefined,
      });
      return formatResult(embeddedResult);
    },
  };

  function formatResult(result: EmbeddedPiRunResult) {
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
  }
}
