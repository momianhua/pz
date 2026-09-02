import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, extname, join } from "node:path";
import { GatewayError } from "./core/errors.js";
import { openCodeInlineConfig } from "./runtime-config.js";

function resolveExecutable(command) {
  if (process.platform !== "win32" || extname(command) || command.includes("/") || command.includes("\\")) return command;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const extension of [".cmd", ".exe", ".bat"]) {
      const candidate = join(directory, `${command}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

export class OpenCodeServerManager {
  constructor(config) {
    this.config = config;
    this.child = null;
  }

  healthHeaders() {
    if (!this.config.openCodePassword) return {};
    const token = Buffer.from(`${this.config.openCodeUsername}:${this.config.openCodePassword}`).toString("base64");
    return { Authorization: `Basic ${token}` };
  }

  async start() {
    if (!this.config.openCodeAutostart) return;
    try {
      const response = await fetch(`${this.config.openCodeBaseUrl}/global/health`, { headers: this.healthHeaders(), signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* Start a managed server below. */ }
    const url = new URL(this.config.openCodeBaseUrl);
    const command = resolveExecutable(this.config.openCodeCommand);
    const env = {
      ...process.env,
      LOCAL_MODEL_API_KEY: this.config.localModelApiKey,
      OPENCODE_SERVER_PASSWORD: this.config.openCodePassword,
    };
    const inlineConfig = openCodeInlineConfig(this.config);
    if (inlineConfig) env.OPENCODE_CONFIG_CONTENT = inlineConfig;
    this.child = spawn(command, ["serve", "--hostname", url.hostname, "--port", url.port || "80"], {
      cwd: this.config.openCodeDirectory,
      env,
      shell: process.platform === "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let diagnostics = "";
    this.child.stdout.on("data", (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-4000); });
    this.child.stderr.on("data", (chunk) => { diagnostics = `${diagnostics}${chunk}`.slice(-4000); });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (this.child.exitCode !== null) break;
      try {
        const response = await fetch(`${this.config.openCodeBaseUrl}/global/health`, { headers: this.healthHeaders(), signal: AbortSignal.timeout(500) });
        if (response.ok) return;
      } catch { /* Continue waiting. */ }
    }
    this.stop();
    throw new GatewayError("ENGINE_UNAVAILABLE", `Managed OpenCode server did not start: ${diagnostics}`, 503);
  }

  stop() {
    if (this.child && this.child.exitCode === null) this.child.kill();
    this.child = null;
  }
}
