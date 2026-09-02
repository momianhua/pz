import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { delimiter, dirname, extname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { EngineAdapter } from "./adapter.js";
import { GatewayError } from "../core/errors.js";
import { event } from "../core/events.js";

export function resolveCommand(command) {
  if (process.platform !== "win32" || extname(command) || command.includes("/") || command.includes("\\")) return command;
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";");
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension.toLowerCase()}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

export function attachStrictJsonlReader(stream, onValue, onError) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const consume = () => {
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) continue;
      try { onValue(JSON.parse(line)); } catch (error) { onError(error, line); }
    }
  };
  stream.on("data", (chunk) => { buffer += decoder.write(chunk); consume(); });
  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer.endsWith("\r")) buffer = buffer.slice(0, -1);
    if (buffer) {
      try { onValue(JSON.parse(buffer)); } catch (error) { onError(error, buffer); }
    }
  });
}

class PiProcess {
  constructor(process, engineSessionId) {
    this.process = process;
    this.engineSessionId = engineSessionId;
    this.events = [];
    this.waiters = [];
    this.closed = false;
    attachStrictJsonlReader(process.stdout, (value) => this.push(value), (error, line) => {
      this.push({ type: "protocol_error", error: error.message, line });
    });
    process.stderr.on("data", (chunk) => {
      this.lastStderr = `${this.lastStderr ?? ""}${chunk}`.slice(-4000);
    });
    process.on("exit", (code) => {
      this.closed = true;
      this.push({ type: "process_exit", code, stderr: this.lastStderr });
    });
  }

  push(value) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value); else this.events.push(value);
  }

  next() {
    if (this.events.length) return Promise.resolve(this.events.shift());
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  send(command) {
    if (this.closed) throw new GatewayError("ENGINE_UNAVAILABLE", "Pi process is not running", 503);
    this.process.stdin.write(`${JSON.stringify(command)}\n`);
  }

  stop() {
    if (!this.closed) this.process.kill();
  }
}

export function mapPiEvent(nativeEvent, runId) {
  const base = { nativeType: nativeEvent.type };
  if (nativeEvent.type === "message_update") {
    const update = nativeEvent.assistantMessageEvent ?? {};
    if (update.type === "text_delta") {
      return event("message.delta", "pi", runId, { ...base, delta: update.delta ?? "" });
    }
    if (update.type === "thinking_delta") {
      return event("reasoning.delta", "pi", runId, { ...base, delta: update.delta ?? "" });
    }
  }
  if (nativeEvent.type === "tool_execution_start") {
    return event("tool.started", "pi", runId, { ...base, toolCallId: nativeEvent.toolCallId, toolName: nativeEvent.toolName, args: nativeEvent.args });
  }
  if (nativeEvent.type === "tool_execution_end") {
    return event("tool.completed", "pi", runId, { ...base, toolCallId: nativeEvent.toolCallId, toolName: nativeEvent.toolName, result: nativeEvent.result, isError: nativeEvent.isError });
  }
  if (nativeEvent.type === "extension_error" || nativeEvent.type === "protocol_error") {
    return event("run.warning", "pi", runId, { ...base, message: nativeEvent.error ?? nativeEvent.message });
  }
  return null;
}

export class PiRpcAdapter extends EngineAdapter {
  constructor(config) {
    super();
    this.config = config;
    const resolvedCommand = resolveCommand(config.piCommand);
    const npmCli = join(dirname(resolvedCommand), "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    if (process.platform === "win32" && [".cmd", ".bat", ".ps1"].includes(extname(resolvedCommand).toLowerCase()) && existsSync(npmCli)) {
      this.command = process.execPath;
      this.commandArgs = [npmCli];
    } else {
      this.command = resolvedCommand;
      this.commandArgs = [];
    }
    this.processes = new Map();
    this.sessionDirectories = new Map();
  }

  metadata() {
    return {
      name: "pi",
      displayName: "Pi Agent",
      transport: "JSONL/RPC subprocess",
      mode: "real",
      capabilities: { streaming: true, sessions: true, toolCalling: true, cancellation: true, contextImport: true },
    };
  }

  async healthCheck() {
    return new Promise((resolveHealth) => {
      let settled = false;
      let output = "";
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolveHealth(result);
      };
      const child = spawn(this.command, [...this.commandArgs, "--version"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.on("error", (error) => finish({ status: "unhealthy", detail: error.message }));
      child.on("close", (code) => finish(code === 0
        ? { status: "healthy", version: output.trim() }
        : { status: "unhealthy", detail: output.trim() || `Pi exited with code ${code}` }));
      const timeout = setTimeout(() => {
        child.kill();
        finish({ status: "unhealthy", detail: "Pi version probe timed out" });
      }, 5000);
    });
  }

  async createSession({ logicalSessionId, directory }) {
    const id = `pi_${randomUUID()}`;
    this.sessionDirectories.set(id, directory || "");
    return { id, logicalSessionId };
  }

  async ensureProcess(engineSessionId) {
    const existing = this.processes.get(engineSessionId);
    if (existing && !existing.closed) return existing;
    const directory = resolve(this.config.piSessionRoot, engineSessionId);
    await mkdir(directory, { recursive: true });
    const hasSavedSession = (await readdir(directory)).length > 0;
    const args = ["--mode", "rpc", "--session-dir", directory, "--name", engineSessionId];
    if (hasSavedSession) args.push("--continue");
    if (this.config.piProvider) args.push("--provider", this.config.piProvider);
    if (this.config.piModel) args.push("--model", this.config.piModel);
    const workingDirectory = this.sessionDirectories.get(engineSessionId) || undefined;
    const child = spawn(this.command, [...this.commandArgs, ...args], { cwd: workingDirectory, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const process = new PiProcess(child, engineSessionId);
    child.on("error", (error) => process.push({ type: "process_exit", code: -1, stderr: error.message }));
    this.processes.set(engineSessionId, process);
    return process;
  }

  async *run({ runId, engineSessionId, input, importedHistory = [], model, signal }) {
    const process = await this.ensureProcess(engineSessionId);
    const prompt = importedHistory.length
      ? `以下是从其他引擎迁移的对话记录，仅作为上下文：\n${importedHistory.map((m) => `${m.role}: ${m.content}`).join("\n")}\n\n当前请求：${input}`
      : input;
    yield event("run.started", "pi", runId, { engineSessionId });
    if (model?.providerID && model?.modelID) {
      const modelRequestId = randomUUID();
      process.send({ id: modelRequestId, type: "set_model", provider: model.providerID, modelId: model.modelID });
      while (true) {
        const response = await process.next();
        if (response.type === "process_exit") {
          throw new GatewayError("ENGINE_UNAVAILABLE", `Pi exited (${response.code}): ${response.stderr ?? ""}`, 503);
        }
        if (response.type === "response" && response.id === modelRequestId) {
          if (!response.success) throw new GatewayError("ENGINE_ERROR", response.error ?? "Pi rejected the requested model", 502);
          break;
        }
      }
    }
    const requestId = randomUUID();
    process.send({ id: requestId, type: "prompt", message: prompt });
    let completedText = "";
    const abort = () => process.send({ type: "abort" });
    signal?.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        const nativeEvent = await process.next();
        if (nativeEvent.type === "process_exit") {
          throw new GatewayError("ENGINE_UNAVAILABLE", `Pi exited (${nativeEvent.code}): ${nativeEvent.stderr ?? ""}`, 503);
        }
        const mapped = mapPiEvent(nativeEvent, runId);
        if (mapped) {
          if (mapped.type === "message.delta") completedText += mapped.data.delta;
          yield mapped;
        }
        if (nativeEvent.type === "agent_settled") break;
      }
      yield event("message.completed", "pi", runId, { text: completedText });
      yield event("run.completed", "pi", runId, { finishReason: "stop" });
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async closeSession(sessionId) {
    this.processes.get(sessionId)?.stop();
    this.processes.delete(sessionId);
    this.sessionDirectories.delete(sessionId);
  }

  async shutdown() {
    for (const process of this.processes.values()) process.stop();
    this.processes.clear();
  }
}
