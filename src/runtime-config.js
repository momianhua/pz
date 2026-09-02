import { mkdir, writeFile } from "node:fs/promises";

export function localModelDefinition(config) {
  if (!config.localModelBaseUrl) return null;
  return {
    providerId: config.localModelProviderId,
    modelId: config.localModelId,
    baseUrl: config.localModelBaseUrl.replace(/\/$/, ""),
    contextWindow: config.localModelContextWindow,
    maxTokens: config.localModelMaxTokens,
  };
}

export function openCodeInlineConfig(config) {
  const model = localModelDefinition(config);
  if (!model) return "";
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: {
      [model.providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: `Local model (${model.baseUrl})`,
        options: {
          baseURL: model.baseUrl,
          apiKey: "{env:LOCAL_MODEL_API_KEY}",
        },
        models: {
          [model.modelId]: {
            name: model.modelId,
            limit: { context: model.contextWindow, output: model.maxTokens },
          },
        },
      },
    },
    permission: {
      question: "allow",
      bash: config.openCodePermissionMode,
      edit: config.openCodePermissionMode,
      external_directory: config.openCodePermissionMode,
    },
  });
}

export async function prepareLocalModelRuntime(config) {
  const model = localModelDefinition(config);
  if (!model) return;
  await mkdir(config.piAgentDir, { recursive: true });
  const piConfig = {
    providers: {
      [model.providerId]: {
        baseUrl: model.baseUrl,
        api: "openai-completions",
        apiKey: "$LOCAL_MODEL_API_KEY",
        authHeader: true,
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsUsageInStreaming: false,
          maxTokensField: "max_tokens",
        },
        models: [{
          id: model.modelId,
          name: model.modelId,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        }],
      },
    },
  };
  await writeFile(`${config.piAgentDir}/models.json`, JSON.stringify(piConfig, null, 2), "utf8");
}
