import { MockAdapter } from "../adapters/mock-adapter.js";
import { PiRpcAdapter } from "../adapters/pi-rpc-adapter.js";
import { OpenCodeHttpAdapter } from "../adapters/opencode-http-adapter.js";
import { OpenCodeServerManager } from "../opencode-server-manager.js";

function validateAdapters(adapters) {
  const names = new Set();
  for (const adapter of adapters) {
    for (const method of ["metadata", "healthCheck", "createSession", "run"]) {
      if (typeof adapter?.[method] !== "function") throw new TypeError(`Engine adapter is missing ${method}()`);
    }
    const name = adapter.metadata()?.name;
    if (!name || typeof name !== "string") throw new TypeError("Engine adapter metadata requires a name");
    if (names.has(name)) throw new Error(`Duplicate engine adapter: ${name}`);
    names.add(name);
  }
}

export class EngineRegistry {
  constructor() {
    this.definitions = new Map();
  }

  register(definition) {
    if (!definition?.name || typeof definition.createAdapter !== "function") {
      throw new TypeError("Engine definition requires name and createAdapter");
    }
    if (this.definitions.has(definition.name)) throw new Error(`Engine already registered: ${definition.name}`);
    this.definitions.set(definition.name, Object.freeze({ ...definition }));
    return this;
  }

  names() {
    return [...this.definitions.keys()];
  }

  async createRuntime(config, adapterOverrides) {
    if (adapterOverrides) validateAdapters(adapterOverrides);
    const overrideNames = new Set((adapterOverrides ?? []).map((adapter) => adapter.metadata().name));
    if (!this.definitions.has(config.defaultEngine) && !overrideNames.has(config.defaultEngine)) {
      throw new Error(`Unknown default engine: ${config.defaultEngine}`);
    }
    const adapters = adapterOverrides ? [...adapterOverrides] : [];
    const services = new Map();
    try {
      for (const definition of this.definitions.values()) {
        if (!adapterOverrides) {
          const adapter = config.engineMode === "mock"
            ? new MockAdapter(definition.name)
            : definition.createAdapter(config);
          if (typeof adapter?.metadata !== "function") throw new TypeError("Engine adapter is missing metadata()");
          const adapterName = adapter.metadata()?.name;
          if (adapterName !== definition.name) {
            throw new Error(`Engine adapter name ${adapterName} does not match registration ${definition.name}`);
          }
          adapters.push(adapter);
        }
        if (definition.createService) {
          const service = definition.createService(config);
          services.set(definition.name, service);
          if (config.engineMode !== "mock" && definition.name === config.defaultEngine) await service.start();
        }
      }
      validateAdapters(adapters);
    } catch (error) {
      await Promise.allSettled([...services.values()].map((service) => service.stop?.()));
      throw error;
    }
    return {
      adapters,
      services,
      async stop() {
        await Promise.allSettled([...services.values()].map((service) => service.stop?.()));
      },
    };
  }
}

export function createDefaultEngineRegistry() {
  return new EngineRegistry()
    .register({ name: "pi", createAdapter: (config) => new PiRpcAdapter(config) })
    .register({
      name: "opencode",
      createAdapter: (config) => new OpenCodeHttpAdapter(config),
      createService: (config) => new OpenCodeServerManager(config),
    });
}
