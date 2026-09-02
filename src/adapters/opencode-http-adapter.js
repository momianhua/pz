import { EngineAdapter } from "./adapter.js";
import { GatewayError } from "../core/errors.js";
import { event } from "../core/events.js";

export async function* parseSse(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines = [];
  const flush = () => {
    if (!dataLines.length) return null;
    const item = { event: eventName, data: dataLines.join("\n") };
    eventName = "message";
    dataLines = [];
    return item;
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line) {
        const item = flush();
        if (item) yield item;
      } else if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
  }
  buffer += decoder.decode();
  if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).trimStart());
  const item = flush();
  if (item) yield item;
}

class AsyncQueue {
  constructor() {
    this.values = [];
    this.waiters = [];
  }

  push(value) {
    const waiter = this.waiters.shift();
    if (waiter) waiter(value); else this.values.push(value);
  }

  next() {
    if (this.values.length) return Promise.resolve(this.values.shift());
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

function sessionIdOf(payload) {
  const properties = payload?.properties ?? {};
  return properties.sessionID ?? properties.sessionId ?? properties.part?.sessionID ?? properties.info?.sessionID;
}

function messageText(payload) {
  const parts = payload?.parts ?? payload?.data?.parts ?? [];
  return parts
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

export function mapOpenCodeEvent(payload, runId) {
  const type = payload?.type;
  const properties = payload?.properties ?? {};
  const base = { nativeType: type };
  if (type === "message.part.delta" && (!properties.field || properties.field === "text")) {
    return event("message.delta", "opencode", runId, { ...base, delta: properties.delta ?? "" });
  }
  if (type === "message.part.updated" && properties.delta) {
    return event("message.delta", "opencode", runId, { ...base, delta: properties.delta });
  }
  if (type === "permission.asked") {
    return event("permission.requested", "opencode", runId, { ...base, permission: properties });
  }
  if (type === "question.asked") {
    return event("question.requested", "opencode", runId, { ...base, question: properties });
  }
  if (type === "tool.execute.before") {
    return event("tool.started", "opencode", runId, { ...base, ...properties });
  }
  if (type === "tool.execute.after") {
    return event("tool.completed", "opencode", runId, { ...base, ...properties });
  }
  if (type === "session.error") {
    return event("run.warning", "opencode", runId, { ...base, message: properties.error?.message ?? properties.error ?? "OpenCode session failed" });
  }
  return null;
}

function mapToolPart(payload, runId, previousStatuses) {
  if (payload?.type !== "message.part.updated") return null;
  const part = payload.properties?.part;
  if (part?.type !== "tool") return null;
  const key = part.callID ?? part.id;
  const status = part.state?.status;
  if (!key || !status || previousStatuses.get(key) === status) return null;
  previousStatuses.set(key, status);
  if (["pending", "running"].includes(status)) {
    return event("tool.started", "opencode", runId, { nativeType: payload.type, toolCallId: key, toolName: part.tool, args: part.state?.input });
  }
  if (["completed", "error"].includes(status)) {
    return event("tool.completed", "opencode", runId, { nativeType: payload.type, toolCallId: key, toolName: part.tool, result: part.state?.output, error: part.state?.error, isError: status === "error" });
  }
  return null;
}

export class OpenCodeHttpAdapter extends EngineAdapter {
  constructor(config) {
    super();
    this.baseUrl = config.openCodeBaseUrl.replace(/\/$/, "");
    this.username = config.openCodeUsername;
    this.password = config.openCodePassword;
    this.directory = config.openCodeDirectory;
    this.providerId = config.openCodeProviderId;
    this.modelId = config.openCodeModelId;
    this.sessionDirectories = new Map();
  }

  metadata() {
    return {
      name: "opencode",
      displayName: "OpenCode",
      transport: "HTTP/OpenAPI + SSE",
      mode: "real",
      capabilities: { streaming: true, sessions: true, toolCalling: true, cancellation: true, permissions: true, contextImport: true },
    };
  }

  url(path, directory = this.directory) {
    const url = new URL(`${this.baseUrl}${path}`);
    if (directory) url.searchParams.set("directory", directory);
    return url;
  }

  headers(extra = {}) {
    const headers = { "Content-Type": "application/json", ...extra };
    if (this.password) {
      headers.Authorization = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`;
    }
    return headers;
  }

  async checkedFetch(path, init = {}, directory = this.directory) {
    let response;
    try {
      response = await fetch(this.url(path, directory), init);
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw new GatewayError("ENGINE_UNAVAILABLE", `Cannot reach OpenCode: ${error.message}`, 503);
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 2000);
      throw new GatewayError("ENGINE_ERROR", `OpenCode returned ${response.status}: ${detail}`, 502);
    }
    return response;
  }

  async healthCheck() {
    try {
      const response = await this.checkedFetch("/global/health", { headers: this.headers() });
      return { status: "healthy", ...(await response.json()) };
    } catch (error) {
      return { status: "unhealthy", detail: error.message };
    }
  }

  async createSession({ logicalSessionId, directory }) {
    const response = await this.checkedFetch("/session", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ title: logicalSessionId }),
    }, directory || this.directory);
    const payload = await response.json();
    const id = payload.id ?? payload.sessionID ?? payload.data?.id;
    if (!id) throw new GatewayError("ENGINE_PROTOCOL_ERROR", "OpenCode create-session response has no session id", 502, payload);
    this.sessionDirectories.set(String(id), directory || this.directory);
    return { id: String(id), logicalSessionId };
  }

  async *run({ runId, engineSessionId, input, importedHistory = [], model, signal }) {
    const directory = this.sessionDirectories.get(engineSessionId) ?? this.directory;
    const contextualInput = importedHistory.length
      ? `以下是从其他引擎迁移的对话记录，仅作为上下文：\n${importedHistory.map((message) => `${message.role}: ${message.content}`).join("\n")}\n\n当前请求：${input}`
      : input;
    yield event("run.started", "opencode", runId, { engineSessionId });

    const eventController = new AbortController();
    const queue = new AsyncQueue();
    const abort = () => {
      eventController.abort();
      void fetch(this.url(`/session/${encodeURIComponent(engineSessionId)}/abort`, directory), { method: "POST", headers: this.headers() }).catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    let pump;
    try {
      const eventResponse = await this.checkedFetch("/event", {
        headers: this.headers({ Accept: "text/event-stream" }),
        signal: eventController.signal,
      }, directory);
      pump = (async () => {
        try {
          for await (const item of parseSse(eventResponse.body)) {
            if (!item.data || item.data === "[DONE]") continue;
            try { queue.push({ kind: "event", payload: JSON.parse(item.data) }); }
            catch { /* Ignore keepalive or non-JSON diagnostic frames. */ }
          }
        } catch (error) {
          if (!eventController.signal.aborted) queue.push({ kind: "streamError", error });
        }
      })();

      const requestBody = { parts: [{ type: "text", text: contextualInput }] };
      const selectedModel = model?.providerID && model?.modelID ? model : (this.providerId && this.modelId
        ? { providerID: this.providerId, modelID: this.modelId }
        : null);
      if (selectedModel) requestBody.model = selectedModel;
      void this.checkedFetch(`/session/${encodeURIComponent(engineSessionId)}/message`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(requestBody),
        signal,
      }, directory).then(async (response) => queue.push({ kind: "result", payload: await response.json() }))
        .catch((error) => queue.push({ kind: "requestError", error }));

      let streamedText = "";
      let result;
      let flushDeadline = 0;
      const toolStatuses = new Map();
      while (true) {
        const remaining = flushDeadline ? flushDeadline - Date.now() : 0;
        if (flushDeadline && remaining <= 0) break;
        const item = flushDeadline
          ? await Promise.race([
            queue.next(),
            new Promise((resolve) => setTimeout(() => resolve({ kind: "flushComplete" }), remaining)),
          ])
          : await queue.next();
        if (item.kind === "flushComplete") break;
        if (item.kind === "requestError") throw item.error;
        if (item.kind === "streamError") {
          yield event("run.warning", "opencode", runId, { message: `OpenCode event stream ended early: ${item.error.message}` });
          continue;
        }
        if (item.kind === "result") {
          result = item.payload;
          // Let already-in-flight SSE frames arrive before using the final response as a tail fallback.
          flushDeadline = Date.now() + 50;
          continue;
        }
        if (sessionIdOf(item.payload) !== engineSessionId) continue;
        const toolEvent = mapToolPart(item.payload, runId, toolStatuses);
        const mapped = toolEvent ?? mapOpenCodeEvent(item.payload, runId);
        if (mapped) {
          if (mapped.type === "message.delta") streamedText += mapped.data.delta ?? "";
          yield mapped;
        }
      }

      if (!result) throw new GatewayError("ENGINE_PROTOCOL_ERROR", "OpenCode request completed without a response payload", 502);
      const finalText = messageText(result);
      if (!streamedText && finalText) {
        yield event("message.delta", "opencode", runId, { delta: finalText, fallback: "synchronous-response" });
      } else if (finalText.startsWith(streamedText) && finalText.length > streamedText.length) {
        yield event("message.delta", "opencode", runId, { delta: finalText.slice(streamedText.length), fallback: "response-tail" });
      }
      yield event("message.completed", "opencode", runId, { text: finalText || streamedText });
      yield event("run.completed", "opencode", runId, { finishReason: "stop" });
    } finally {
      eventController.abort();
      signal?.removeEventListener("abort", abort);
      await pump?.catch(() => {});
    }
  }

  async closeSession(sessionId) {
    const directory = this.sessionDirectories.get(sessionId) ?? this.directory;
    await this.checkedFetch(`/session/${encodeURIComponent(sessionId)}`, { method: "DELETE", headers: this.headers() }, directory);
    this.sessionDirectories.delete(sessionId);
  }

  async replyQuestion(sessionId, requestId, { answers }) {
    const directory = this.sessionDirectories.get(sessionId) ?? this.directory;
    await this.checkedFetch(`/question/${encodeURIComponent(requestId)}/reply`, {
      method: "POST", headers: this.headers(), body: JSON.stringify({ answers }),
    }, directory);
  }

  async replyPermission(sessionId, requestId, { reply, message }) {
    const directory = this.sessionDirectories.get(sessionId) ?? this.directory;
    await this.checkedFetch(`/permission/${encodeURIComponent(requestId)}/reply`, {
      method: "POST", headers: this.headers(), body: JSON.stringify({ reply, ...(message ? { message } : {}) }),
    }, directory);
  }
}
