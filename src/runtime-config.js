import { mkdir, writeFile } from "node:fs/promises";

export function localModelDefinition(config) {
  if (!config.localModelBaseUrl) return null;
  return {
    providerId: config.localModelProviderId,
    modelId: config.localModelId,
    baseUrl: config.localModelBaseUrl.replace(/\/$/, ""),
    contextWindow: config.localModelContextWindow,
    maxTokens: config.localModelMaxTokens,
    authHeader: config.localModelAuthHeader,
  };
}

export function openCodeInlineConfig(config) {
  const model = localModelDefinition(config);
  const inline = {
    $schema: "https://opencode.ai/config.json",
    permission: config.openCodePermissionMode === "allow"
      ? "allow"
      : { "*": config.openCodePermissionMode, question: "allow", skill: "allow" },
  };
  if (config.agentSkillsDir && config.openCodeConfigDir) {
    inline.skills = [config.openCodeConfigDir.replace(/\\/g, "/") + "/skills"];
  }
  if (model) {
    inline.provider = {
      [model.providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: `Local model (${model.baseUrl})`,
        options: {
          baseURL: model.baseUrl,
          ...(!model.authHeader ? { apiKey: "{env:LOCAL_MODEL_API_KEY}" } : {}),
          ...(model.authHeader ? { headers: { [model.authHeader]: "{env:LOCAL_MODEL_AUTH_VALUE}" } } : {}),
        },
        models: {
          [model.modelId]: {
            name: model.modelId,
            limit: { context: model.contextWindow, output: model.maxTokens },
          },
        },
      },
    };
  }
  return JSON.stringify(inline);
}

export async function prepareLocalModelRuntime(config) {
  const model = localModelDefinition(config);
  await mkdir(config.piAgentDir, { recursive: true });
  if (config.piShellPath) {
    await writeFile(`${config.piAgentDir}/settings.json`, JSON.stringify({ shellPath: config.piShellPath }, null, 2), "utf8");
  }
  if (!model) return;
  const piConfig = {
    providers: {
      [model.providerId]: {
        baseUrl: model.baseUrl,
        api: "openai-completions",
        apiKey: "$LOCAL_MODEL_API_KEY",
        authHeader: !model.authHeader,
        ...(model.authHeader ? { headers: { [model.authHeader]: "$LOCAL_MODEL_AUTH_VALUE" } } : {}),
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
