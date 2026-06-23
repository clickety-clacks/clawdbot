// Canonical session model selection resolver for status, controls, and run dispatch.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentHarnessPolicy } from "../agents/harness/policy.js";
import {
  buildModelAliasIndex,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
  resolvePersistedModelRef,
  resolvePersistedOverrideModelRef,
  resolveSubagentConfiguredModelSelection,
} from "../agents/model-selection.js";
import { resolvePersistedSessionRuntimeId } from "../agents/session-runtime-compat.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSubagentSessionKey } from "../routing/session-key.js";

export type SessionModelSelectionSource = "override" | "runtime" | "snapshot" | "default";

export type SessionModelSelectionSnapshot = {
  provider?: string;
  model?: string;
};

type SessionModelSelectionEntry = Pick<
  SessionEntry,
  | "providerOverride"
  | "modelOverride"
  | "modelProvider"
  | "model"
  | "agentRuntimeOverride"
  | "agentHarnessId"
>;

export type ResolvedSessionModelSelection = {
  provider: string;
  model: string;
  runtime: string;
  harnessId?: string;
  source: SessionModelSelectionSource;
};

export function resolveSessionDefaultModelSelection(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  fallback?: { provider: string; model: string };
  allowPluginNormalization?: boolean;
}): { provider: string; model: string } {
  const resolvedDefault =
    params.fallback ??
    resolveDefaultModelForAgent({
      cfg: params.cfg,
      agentId: params.agentId,
      allowPluginNormalization: params.allowPluginNormalization,
    });
  if (!params.agentId || !isSubagentSessionKey(params.sessionKey ?? "")) {
    return resolvedDefault;
  }
  const subagentModel = resolveSubagentConfiguredModelSelection({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (!subagentModel) {
    return resolvedDefault;
  }
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: resolvedDefault.provider,
    allowPluginNormalization: params.allowPluginNormalization,
  });
  return (
    resolveModelRefFromString({
      cfg: params.cfg,
      raw: subagentModel,
      defaultProvider: resolvedDefault.provider,
      aliasIndex,
      allowPluginNormalization: params.allowPluginNormalization,
    })?.ref ?? { provider: resolvedDefault.provider, model: subagentModel }
  );
}

export function resolveSessionModelSelection(params: {
  cfg: OpenClawConfig;
  entry?: Partial<SessionModelSelectionEntry>;
  agentId?: string;
  sessionKey?: string;
  fallback?: { provider: string; model: string };
  allowPluginNormalization?: boolean;
  snapshot?: SessionModelSelectionSnapshot | null;
}): ResolvedSessionModelSelection {
  const defaultModel = resolveSessionDefaultModelSelection({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    fallback: params.fallback,
    allowPluginNormalization: params.allowPluginNormalization,
  });
  const overrideProvider = normalizeOptionalString(params.entry?.providerOverride);
  const overrideModel = normalizeOptionalString(params.entry?.modelOverride);
  const runtimeProvider = normalizeOptionalString(params.entry?.modelProvider);
  const runtimeModel = normalizeOptionalString(params.entry?.model);
  const snapshotProvider = normalizeOptionalString(params.snapshot?.provider);
  const snapshotModel = normalizeOptionalString(params.snapshot?.model);

  const override = resolvePersistedOverrideModelRef({
    defaultProvider: defaultModel.provider,
    overrideProvider,
    overrideModel,
    allowPluginNormalization: params.allowPluginNormalization,
  });
  const runtime = resolvePersistedModelRef({
    defaultProvider: defaultModel.provider,
    runtimeProvider,
    runtimeModel,
    allowPluginNormalization: params.allowPluginNormalization,
  });
  const snapshot = resolvePersistedModelRef({
    defaultProvider: defaultModel.provider,
    runtimeProvider: snapshotProvider,
    runtimeModel: snapshotModel,
    allowPluginNormalization: params.allowPluginNormalization,
  });

  const selected = override
    ? { provider: override.provider, model: override.model, source: "override" as const }
    : runtime
      ? { provider: runtime.provider, model: runtime.model, source: "runtime" as const }
      : snapshot
        ? { provider: snapshot.provider, model: snapshot.model, source: "snapshot" as const }
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
