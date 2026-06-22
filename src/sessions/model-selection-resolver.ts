// Canonical session model selection resolver for status, controls, and run dispatch.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentHarnessPolicy } from "../agents/harness/policy.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { resolvePersistedSessionRuntimeId } from "../agents/session-runtime-compat.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type SessionModelSelectionSource = "override" | "runtime" | "snapshot" | "default";

export type SessionModelSelectionSnapshot = {
  provider?: string;
  model?: string;
};

export type ResolvedSessionModelSelection = {
  provider: string;
  model: string;
  runtime: string;
  harnessId?: string;
  source: SessionModelSelectionSource;
};

export function resolveSessionModelSelection(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  agentId?: string;
  sessionKey?: string;
  snapshot?: SessionModelSelectionSnapshot | null;
}): ResolvedSessionModelSelection {
  const defaultModel = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const overrideProvider = normalizeOptionalString(params.entry?.providerOverride);
  const overrideModel = normalizeOptionalString(params.entry?.modelOverride);
  const runtimeProvider = normalizeOptionalString(params.entry?.modelProvider);
  const runtimeModel = normalizeOptionalString(params.entry?.model);
  const snapshotProvider = normalizeOptionalString(params.snapshot?.provider);
  const snapshotModel = normalizeOptionalString(params.snapshot?.model);

  const selected =
    overrideProvider && overrideModel
      ? { provider: overrideProvider, model: overrideModel, source: "override" as const }
      : runtimeModel
        ? {
            provider: runtimeProvider ?? defaultModel.provider,
            model: runtimeModel,
            source: "runtime" as const,
          }
        : snapshotModel
          ? {
              provider: snapshotProvider ?? defaultModel.provider,
              model: snapshotModel,
              source: "snapshot" as const,
            }
          : {
              provider: defaultModel.provider,
              model: defaultModel.model,
              source: "default" as const,
            };

  const policy = resolveAgentHarnessPolicy({
    provider: selected.provider,
    modelId: selected.model,
    config: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const persistedRuntime = resolvePersistedSessionRuntimeId(params.entry);
  const harnessId = persistedRuntime === policy.runtime ? persistedRuntime : undefined;

  return {
    ...selected,
    runtime: policy.runtime,
    ...(harnessId ? { harnessId } : {}),
  };
}
