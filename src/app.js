import { loadConfig } from "./config.js";
import { AgentGateway } from "./core/gateway.js";
import { JsonSessionStore } from "./core/json-store.js";
import { createHttpServer } from "./http-server.js";
import { prepareLocalModelRuntime } from "./runtime-config.js";
import { prepareSkillRuntime } from "./skill-runtime.js";
import { createDefaultEngineRegistry } from "./engines/registry.js";

export async function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  await prepareLocalModelRuntime(config);
  const skillRuntime = await prepareSkillRuntime(config);
  const engineRegistry = overrides.engineRegistry ?? createDefaultEngineRegistry();
  const engineRuntime = await engineRegistry.createRuntime(config, overrides.adapters);
  const adapters = engineRuntime.adapters;
  try {
    const store = overrides.store ?? await new JsonSessionStore(config.stateFile).load();
    const gateway = new AgentGateway({ adapters, store, defaultEngine: config.defaultEngine, runTimeoutMs: config.runTimeoutMs });
    const server = createHttpServer({ gateway, config });
    const openCodeServer = engineRuntime.services.get("opencode") ?? { stop() {} };
    return { config, adapters, store, gateway, server, engineRegistry, engineRuntime, openCodeServer, skillRuntime };
  } catch (error) {
    await Promise.allSettled(adapters.map((adapter) => adapter.shutdown?.()));
    await engineRuntime.stop();
    throw error;
  }
}
