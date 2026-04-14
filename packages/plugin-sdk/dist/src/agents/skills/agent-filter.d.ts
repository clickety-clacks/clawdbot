import type { OpenClawConfig } from "../../config/types.js";
/**
 * Explicit per-agent skills win when present; otherwise fall back to shared defaults.
 * Unknown agent ids also fall back to defaults so legacy/unresolved callers do not widen access.
 */
export declare function resolveEffectiveAgentSkillFilter(cfg: OpenClawConfig | undefined, agentId: string | undefined): string[] | undefined;
