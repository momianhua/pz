import { resolve } from "node:path";

function integer(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function commandLine(argv = process.argv.slice(2)) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const match = argument.match(/^--(engine|port|host)(?:=(.*))?$/);
    if (!match) continue;
    const value = match[2] ?? argv[++index];
    if (!value) throw new Error(`Missing value for --${match[1]}`);
    result[match[1]] = value;
  }
  return result;
}

export function loadConfig(overrides = {}) {
  const cli = commandLine(overrides.argv);
  const port = Number.parseInt(cli.port ?? process.env.PORT ?? "6217", 10);
  if (!Number.isFinite(port) || port <= 0) throw new Error("port must be a positive integer");
  return {
    host: cli.host ?? process.env.HOST ?? "localhost",
    port,
    gatewayApiKey: process.env.GATEWAY_API_KEY ?? "",
    defaultEngine: cli.engine ?? process.env.AGENT_ENGINE ?? process.env.DEFAULT_ENGINE ?? "pi",
    engineMode: process.env.ENGINE_MODE ?? "mock",
    stateFile: resolve(process.env.STATE_FILE ?? "./data/state.json"),
    maxBodyBytes: integer("MAX_BODY_BYTES", 1_048_576),
    runTimeoutMs: integer("RUN_TIMEOUT_MS", 120_000),
    piCommand: process.env.PI_COMMAND ?? "pi",
    piProvider: process.env.PI_PROVIDER ?? "",
    piModel: process.env.PI_MODEL ?? "",
    piSessionRoot: resolve(process.env.PI_SESSION_ROOT ?? "./data/pi-sessions"),
    openCodeBaseUrl: process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096",
    openCodeUsername: process.env.OPENCODE_SERVER_USERNAME ?? "opencode",
    openCodePassword: process.env.OPENCODE_SERVER_PASSWORD ?? "",
    openCodeDirectory: resolve(process.env.OPENCODE_DIRECTORY ?? process.cwd()),
    openCodeProviderId: process.env.OPENCODE_PROVIDER_ID ?? "",
    openCodeModelId: process.env.OPENCODE_MODEL_ID ?? "",
    ...overrides,
  };
}
