export declare const QA_AGENTIC_PARITY_PACK = "agentic";
export declare const QA_AGENTIC_PARITY_SCENARIOS: readonly [{
    readonly id: "approval-turn-tool-followthrough";
    readonly title: "Approval turn tool followthrough";
    readonly countsTowardValidToolCallRate: true;
}, {
    readonly id: "model-switch-tool-continuity";
    readonly title: "Model switch with tool continuity";
    readonly countsTowardValidToolCallRate: true;
}, {
    readonly id: "source-docs-discovery-report";
    readonly title: "Source and docs discovery report";
    readonly countsTowardValidToolCallRate: true;
}, {
    readonly id: "image-understanding-attachment";
    readonly title: "Image understanding from attachment";
    readonly countsTowardValidToolCallRate: false;
}, {
    readonly id: "compaction-retry-mutating-tool";
    readonly title: "Compaction retry after mutating tool";
    readonly countsTowardValidToolCallRate: true;
}, {
    readonly id: "subagent-handoff";
    readonly title: "Subagent handoff";
    readonly countsTowardValidToolCallRate: true;
}, {
    readonly id: "subagent-fanout-synthesis";
    readonly title: "Subagent fanout synthesis";
    readonly countsTowardValidToolCallRate: true;
}, {
    readonly id: "memory-recall";
    readonly title: "Memory recall after context switch";
    readonly countsTowardValidToolCallRate: false;
}, {
    readonly id: "thread-memory-isolation";
    readonly title: "Thread memory isolation";
    readonly countsTowardValidToolCallRate: true;
}, {
    readonly id: "config-restart-capability-flip";
    readonly title: "Config restart capability flip";
    readonly countsTowardValidToolCallRate: true;
}, {
    readonly id: "instruction-followthrough-repo-contract";
    readonly title: "Instruction followthrough repo contract";
    readonly countsTowardValidToolCallRate: true;
}];
export declare const QA_AGENTIC_PARITY_SCENARIO_IDS: ("approval-turn-tool-followthrough" | "model-switch-tool-continuity" | "source-docs-discovery-report" | "image-understanding-attachment" | "compaction-retry-mutating-tool" | "subagent-handoff" | "subagent-fanout-synthesis" | "memory-recall" | "thread-memory-isolation" | "config-restart-capability-flip" | "instruction-followthrough-repo-contract")[];
export declare const QA_AGENTIC_PARITY_SCENARIO_TITLES: ("Approval turn tool followthrough" | "Model switch with tool continuity" | "Source and docs discovery report" | "Image understanding from attachment" | "Compaction retry after mutating tool" | "Subagent handoff" | "Subagent fanout synthesis" | "Memory recall after context switch" | "Thread memory isolation" | "Config restart capability flip" | "Instruction followthrough repo contract")[];
export declare const QA_AGENTIC_PARITY_TOOL_BACKED_SCENARIO_TITLES: ("Approval turn tool followthrough" | "Model switch with tool continuity" | "Source and docs discovery report" | "Image understanding from attachment" | "Compaction retry after mutating tool" | "Subagent handoff" | "Subagent fanout synthesis" | "Memory recall after context switch" | "Thread memory isolation" | "Config restart capability flip" | "Instruction followthrough repo contract")[];
export declare function resolveQaParityPackScenarioIds(params: {
    parityPack?: string;
    scenarioIds?: string[];
}): string[];
