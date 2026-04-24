import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

export const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

export function buildOpenAICodexProvider(): ModelProviderConfig {
  return {
    baseUrl: OPENAI_CODEX_BASE_URL,
    api: "openai-codex-responses",
    models: [
      {
        id: "gpt-5.5",
        name: "gpt-5.5",
        api: "openai-codex-responses",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        contextTokens: 272_000,
        maxTokens: 128_000,
        compat: {
          supportsReasoningEffort: true,
          supportsUsageInStreaming: true,
        },
      },
    ],
  };
}
