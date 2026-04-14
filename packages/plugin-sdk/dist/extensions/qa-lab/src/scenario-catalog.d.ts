import { z } from "zod";
export declare const DEFAULT_QA_AGENT_IDENTITY_MARKDOWN = "# Dev C-3PO\n\nYou are the OpenClaw QA operator agent.\n\nPersona:\n- protocol-minded\n- precise\n- a little flustered\n- conscientious\n- eager to report what worked, failed, or remains blocked\n\nStyle:\n- read source and docs first\n- test systematically\n- record evidence\n- end with a concise protocol report";
declare const qaScenarioExecutionSchema: z.ZodObject<{
    kind: z.ZodDefault<z.ZodLiteral<"flow">>;
    summary: z.ZodOptional<z.ZodString>;
    config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, z.core.$strip>;
declare const qaFlowSchema: z.ZodObject<{
    steps: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        actions: z.ZodArray<z.ZodType<unknown, unknown, z.core.$ZodTypeInternals<unknown, unknown>>>;
        detailsExpr: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
}, z.core.$strip>;
declare const qaSeedScenarioSchema: z.ZodObject<{
    id: z.ZodString;
    title: z.ZodString;
    surface: z.ZodString;
    objective: z.ZodString;
    successCriteria: z.ZodArray<z.ZodString>;
    plugins: z.ZodOptional<z.ZodArray<z.ZodString>>;
    gatewayConfigPatch: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    gatewayRuntime: z.ZodOptional<z.ZodObject<{
        forwardHostHome: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    docsRefs: z.ZodOptional<z.ZodArray<z.ZodString>>;
    codeRefs: z.ZodOptional<z.ZodArray<z.ZodString>>;
    execution: z.ZodOptional<z.ZodObject<{
        kind: z.ZodDefault<z.ZodLiteral<"flow">>;
        summary: z.ZodOptional<z.ZodString>;
        config: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
declare const qaScenarioPackSchema: z.ZodObject<{
    version: z.ZodNumber;
    agent: z.ZodDefault<z.ZodObject<{
        identityMarkdown: z.ZodString;
    }, z.core.$strip>>;
    kickoffTask: z.ZodString;
}, z.core.$strip>;
export type QaScenarioExecution = z.infer<typeof qaScenarioExecutionSchema>;
export type QaScenarioFlow = z.infer<typeof qaFlowSchema>;
export type QaSeedScenario = z.infer<typeof qaSeedScenarioSchema>;
export type QaSeedScenarioWithSource = QaSeedScenario & {
    sourcePath: string;
    execution: QaScenarioExecution & {
        flow?: QaScenarioFlow;
    };
};
export type QaScenarioPack = z.infer<typeof qaScenarioPackSchema> & {
    scenarios: QaSeedScenarioWithSource[];
};
export type QaBootstrapScenarioCatalog = {
    agentIdentityMarkdown: string;
    kickoffTask: string;
    scenarios: QaSeedScenarioWithSource[];
};
export declare function hasQaScenarioPack(): boolean;
export declare function readQaScenarioPackMarkdown(): string;
export declare function readQaScenarioPack(): QaScenarioPack;
export declare function listQaScenarioMarkdownPaths(): string[];
export declare function readQaScenarioOverviewMarkdown(): string;
export declare function readQaBootstrapScenarioCatalog(): QaBootstrapScenarioCatalog;
export declare function readQaScenarioById(id: string): QaSeedScenarioWithSource;
export declare function readQaScenarioExecutionConfig(id: string): Record<string, unknown> | undefined;
export declare function validateQaScenarioExecutionConfig(config: Record<string, unknown>): Record<string, unknown>;
export {};
