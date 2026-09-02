import { loadConfig } from "./config.js";
import { MockAdapter } from "./adapters/mock-adapter.js";
import { PiRpcAdapter } from "./adapters/pi-rpc-adapter.js";
import { OpenCodeHttpAdapter } from "./adapters/opencode-http-adapter.js";
import { AgentGateway } from "./core/gateway.js";
import { JsonSessionStore } from "./core/json-store.js";
import { createHttpServer } from "./http-server.js";

export async function createApp(overrides = {}) {
  const config = loadConfig(overrides);
  const adapters = overrides.adapters ?? (config.engineMode === "mock"
    ? [new MockAdapter("pi"), new MockAdapter("opencode")]
    : [new PiRpcAdapter(config), new OpenCodeHttpAdapter(config)]);
  const store = overrides.store ?? await new JsonSessionStore(config.stateFile).load();
  const gateway = new AgentGateway({ adapters, store, defaultEngine: config.defaultEngine, runTimeoutMs: config.runTimeoutMs });
  const server = createHttpServer({ gateway, config });
  return { config, adapters, store, gateway, server };
}
