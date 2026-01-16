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
import {
  buildClawlineSessionKey,
  clawlineSessionFileName,
} from "./session-key.js";

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
      ?.map((entry) => (entry.isError ? null : entry.text?.trim()))
      .filter((value): value is string => Boolean(value)) ?? [];
  if (texts.length === 0) return null;
  return texts.join("\n\n");
}

function extractErrorText(result: EmbeddedPiRunResult): string | null {
  const errorEntry = result.payloads?.find(
    (entry) => entry.isError && typeof entry.text === "string",
  );
  return errorEntry?.text?.trim() || null;
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
      const sessionKey = buildClawlineSessionKey(ctx.userId, ctx.deviceId);
      const sessionFile = path.join(
        sessionDir,
        `${clawlineSessionFileName(sessionKey)}.jsonl`,
      );
      await fs.mkdir(path.dirname(sessionFile), { recursive: true });
      const runId = randomUUID();
      const result = await runEmbeddedPiAgent({
        sessionId: ctx.sessionId,
        sessionKey,
        sessionFile,
        workspaceDir,
        agentDir: agentDirPath,
        config: params.config,
        skillsSnapshot: undefined,
        prompt: ctx.prompt,
        provider: providerName,
        model: modelName,
        thinkLevel: params.config.agents?.defaults?.thinkingDefault,
        verboseLevel: defaultVerboseLevel,
        reasoningLevel: defaultReasoningLevel,
        bashElevated: defaultBashElevated,
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

  function formatResult(result: EmbeddedPiRunResult) {
    const text = extractText(result);
    if (text) {
      return { exitCode: 0, output: text };
    }

    const errorText = extractErrorText(result);
    if (errorText && isContextOverflowError(errorText)) {
      logger.warn?.("[clawline] agent run hit context overflow");
      return {
        exitCode: 1,
        output: CONTEXT_OVERFLOW_FALLBACK,
      };
    }

    const fallback = resolved.adapterOverrides.responseFallback ?? "";
    if (!fallback) {
      logger.warn?.(
        "[clawline] adapter returned no text; consider setting clawline.adapter.responseFallback",
      );
    }
    return { exitCode: 1, output: fallback };
  }
}

function logAgentEvent(
  logger: Logger,
  runId: string,
  evt: { stream: string; data: Record<string, unknown> },
) {
  const phase =
    typeof evt.data?.phase === "string" ? evt.data.phase : undefined;
  if (evt.stream === "error") {
    logger.error?.(
      `[clawline] agent error (runId=${runId}): ${String(
        evt.data?.message ?? "",
      )}`,
    );
    return;
  }
  if (evt.stream === "compaction" && phase) {
    logger.info?.(
      `[clawline] compaction ${phase} (runId=${runId})`,
    );
    return;
  }
  if (evt.stream === "tool" && phase === "start") {
    const tool =
      typeof evt.data?.tool === "string" ? evt.data.tool : undefined;
    logger.info?.(
      `[clawline] tool start${tool ? ` (${tool})` : ""} (runId=${runId})`,
    );
    return;
  }
  if (
    evt.stream === "lifecycle" &&
    phase &&
    (phase === "start" || phase === "end")
  ) {
    logger.info?.(
      `[clawline] run ${phase} (runId=${runId})`,
    );
  }
}

async function loadCliSessionIds(
  filePath: string,
  logger: Logger,
): Promise<Map<string, string>> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entries = Object.entries(parsed ?? {}).flatMap<
      [string, string]
    >(([key, value]) => {
      if (typeof value !== "string") return [];
      return [[key, value]];
    });
    return new Map(entries);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn?.(
        `[clawline] failed to load CLI session ids: ${String(err)}`,
      );
    }
    return new Map();
  }
}

async function persistCliSessionIds(
  filePath: string,
  cliSessionIds: Map<string, string>,
  logger: Logger,
): Promise<void> {
  try {
    const obj = Object.fromEntries(cliSessionIds.entries());
    await fs.writeFile(filePath, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  } catch (err) {
    logger.warn?.(
      `[clawline] failed to persist CLI session ids: ${String(err)}`,
    );
  }
}
