import { join, resolve } from "node:path";

function integer(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? String(fallback), 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function boolean(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function choice(name, allowed, fallback) {
  const value = process.env[name] || fallback;
  if (!allowed.includes(value)) throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
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
  const localModelBaseUrl = process.env.LOCAL_MODEL_BASE_URL ?? "";
  const localModelProviderId = process.env.LOCAL_MODEL_PROVIDER_ID ?? "local-openai";
  const localModelId = process.env.LOCAL_MODEL_ID ?? "deepseek";
  const localModelApiKey = process.env.LOCAL_MODEL_API_KEY || "local";
  const localModelAuthHeader = (process.env.LOCAL_MODEL_AUTH_HEADER ?? "").trim();
  if (localModelAuthHeader && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(localModelAuthHeader)) {
    throw new Error("LOCAL_MODEL_AUTH_HEADER must be a valid HTTP header name");
  }
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
    runTimeoutMs: integer("RUN_TIMEOUT_MS", 600_000),
    piCommand: process.env.PI_COMMAND ?? "pi",
    piProvider: process.env.PI_PROVIDER || (localModelBaseUrl ? localModelProviderId : ""),
    piModel: process.env.PI_MODEL || (localModelBaseUrl ? localModelId : ""),
    piSessionRoot: resolve(process.env.PI_SESSION_ROOT ?? "./data/pi-sessions"),
    piAgentDir: resolve(process.env.PI_AGENT_DIR ?? "./data/runtime/pi-agent"),
    agentSkillsDir: process.env.AGENT_SKILLS_DIR ? resolve(process.env.AGENT_SKILLS_DIR) : "",
    piShellPath: process.env.PI_SHELL_PATH ?? (process.platform === "win32"
      ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : ""),
    openCodeBaseUrl: process.env.OPENCODE_BASE_URL ?? "http://127.0.0.1:4096",
    openCodeUsername: process.env.OPENCODE_SERVER_USERNAME ?? "opencode",
    openCodePassword: process.env.OPENCODE_SERVER_PASSWORD ?? "",
    openCodeDirectory: resolve(process.env.OPENCODE_DIRECTORY ?? process.cwd()),
    openCodeConfigDir: resolve(process.env.OPENCODE_CONFIG_DIR ?? "./data/runtime/opencode"),
    openCodeProviderId: process.env.OPENCODE_PROVIDER_ID || (localModelBaseUrl ? localModelProviderId : ""),
    openCodeModelId: process.env.OPENCODE_MODEL_ID || (localModelBaseUrl ? localModelId : ""),
    openCodeCommand: process.env.OPENCODE_COMMAND ?? "opencode",
    openCodeAutostart: boolean("OPENCODE_AUTOSTART", false),
    openCodePermissionMode: choice("OPENCODE_PERMISSION_MODE", ["allow", "ask", "deny"], "allow"),
    localModelBaseUrl,
    localModelProviderId,
    localModelId,
    localModelApiKey,
    localModelAuthHeader,
    localModelAuthValue: process.env.LOCAL_MODEL_AUTH_VALUE || localModelApiKey,
    localModelContextWindow: integer("LOCAL_MODEL_CONTEXT_WINDOW", 32768),
    localModelMaxTokens: integer("LOCAL_MODEL_MAX_TOKENS", 8192),
    ...overrides,
  };
}
