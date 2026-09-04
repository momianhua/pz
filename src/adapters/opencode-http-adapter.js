import { EngineAdapter } from "./adapter.js";
import { GatewayError } from "../core/errors.js";
import { event } from "../core/events.js";
import { withRuntimeGuidance } from "../core/runtime-guidance.js";

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

function retryDelay(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function nestedErrorMessage(value, seen = new Set(), depth = 0) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!value || typeof value !== "object" || depth > 6 || seen.has(value)) return null;
  seen.add(value);

  for (const key of ["message", "detail", "statusText", "responseBody", "body"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  for (const key of ["error", "cause", "data", "response"]) {
    const candidate = nestedErrorMessage(value[key], seen, depth + 1);
    if (candidate) return candidate;
  }
  return null;
}

export function openCodeErrorMessage(error) {
  if (typeof error === "string" && error.trim()) return error.trim();
  const message = nestedErrorMessage(error);
  const name = typeof error?.name === "string" ? error.name.trim() : "";
  if (message) return name && !message.toLowerCase().includes(name.toLowerCase()) ? `${name}: ${message}` : message;
  try {
    const serialized = JSON.stringify(error);
    if (serialized && serialized !== "{}") return serialized;
  } catch {
    // Circular provider errors still receive a useful generic message.
  }
  return name || "OpenCode session failed";
}

export function openCodeAgentName(agent) {
  if (typeof agent !== "string") return undefined;
  const name = agent.trim();
  // "assistant" is the gateway protocol's default role, not an OpenCode
  // native agent. Omitting it lets OpenCode choose its configured default.
  return !name || name.toLowerCase() === "assistant" ? undefined : name;
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
    return event("permission.requested", "opencode", runId, {
      ...base,
      permission: { ...properties, id: properties.id ?? properties.requestID ?? properties.permissionID },
    });
  }
  if (type === "permission.replied" || type === "permission.resolved") {
    return event("permission.resolved", "opencode", runId, {
      ...base,
      requestId: properties.id ?? properties.requestID ?? properties.permissionID,
      reply: properties.reply ?? properties.response,
    });
  }
  if (type === "question.asked") {
    return event("question.requested", "opencode", runId, {
      ...base,
      question: { ...properties, id: properties.id ?? properties.requestID },
    });
  }
  if (type === "question.replied" || type === "question.rejected") {
    return event("question.resolved", "opencode", runId, {
      ...base,
      requestId: properties.id ?? properties.requestID,
    });
  }
  if (type === "tool.execute.before") {
    return event("tool.started", "opencode", runId, { ...base, ...properties });
  }
  if (type === "tool.execute.after") {
    return event("tool.completed", "opencode", runId, { ...base, ...properties });
  }
  if (type === "session.error") {
    return event("run.warning", "opencode", runId, { ...base, message: openCodeErrorMessage(properties.error) });
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
    this.permissionMode = config.openCodePermissionMode ?? "allow";
    this.controlRequestTimeoutMs = Number.isInteger(config.openCodeControlRequestTimeoutMs) && config.openCodeControlRequestTimeoutMs > 0
      ? config.openCodeControlRequestTimeoutMs
      : 10_000;
    this.sessionDirectories = new Map();
    this.seenInteractionEvents = new Set();
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

  async checkedFetch(path, init = {}, directory = this.directory, policy = {}) {
    const method = (init.method ?? "GET").toUpperCase();
    const attempts = policy.attempts ?? (["GET", "HEAD"].includes(method) ? 3 : 1);
    const timeoutMs = policy.timeoutMs === undefined ? this.controlRequestTimeoutMs : policy.timeoutMs;
    const connectionOnlyTimeout = policy.connectionOnlyTimeout === true;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let requestTimer;
      try {
        const requestController = timeoutMs > 0 ? new AbortController() : null;
        if (requestController) {
          requestTimer = setTimeout(() => requestController.abort(new Error(`OpenCode request timeout after ${timeoutMs} ms`)), timeoutMs);
          requestTimer.unref?.();
        }
        const signal = requestController && init.signal
          ? AbortSignal.any([init.signal, requestController.signal])
          : (init.signal ?? requestController?.signal);
        const response = await fetch(this.url(path, directory), { ...init, signal });
        if (connectionOnlyTimeout) {
          clearTimeout(requestTimer);
          requestTimer = undefined;
        }
        if (response.ok) {
          // Keep the timeout signal alive while callers consume short response bodies.
          // The timer is unref'ed and harmless after the body has completed.
          if (!connectionOnlyTimeout) requestTimer = undefined;
          return response;
        }
        const detail = (await response.text()).slice(0, 2000);
        const error = new GatewayError(
          response.status >= 500 ? "ENGINE_UNAVAILABLE" : "ENGINE_ERROR",
          `OpenCode returned ${response.status}: ${detail}`,
          response.status >= 500 ? 503 : 502,
          { upstreamStatus: response.status },
        );
        if (response.status < 500 || attempt === attempts) throw error;
        lastError = error;
      } catch (error) {
        if (init.signal?.aborted) throw init.signal.reason ?? error;
        lastError = error instanceof GatewayError ? error : new GatewayError(
          "ENGINE_UNAVAILABLE",
          `Cannot reach OpenCode: ${error.message}${error.cause?.code || error.cause?.message ? ` (${error.cause.code ?? error.cause.message})` : ""}`,
          503,
        );
        if (attempt === attempts) throw lastError;
      } finally {
        clearTimeout(requestTimer);
      }
      await retryDelay(150 * (2 ** (attempt - 1)), init.signal);
    }
    throw lastError;
  }

  rememberInteraction(type, requestId) {
    if (!requestId) return true;
    const key = `${type}:${requestId}`;
    if (this.seenInteractionEvents.has(key)) return false;
    this.seenInteractionEvents.add(key);
    if (this.seenInteractionEvents.size > 2000) {
      const oldest = this.seenInteractionEvents.values().next().value;
      this.seenInteractionEvents.delete(oldest);
    }
    return true;
  }

  async listPermissions(sessionId) {
    const directory = this.sessionDirectories.get(sessionId) ?? this.directory;
    const response = await this.checkedFetch("/permission", { headers: this.headers() }, directory);
    const payload = await response.json();
    return Array.isArray(payload) ? payload : [];
  }

  async isPermissionPending(sessionId, requestId) {
    const permissions = await this.listPermissions(sessionId);
    return permissions.some((item) => (item.id ?? item.requestID ?? item.permissionID) === requestId);
  }

  async waitForSessionIdle(sessionId, directory, signal) {
    let consecutiveFailures = 0;
    while (!signal?.aborted) {
      try {
        const response = await this.checkedFetch("/session/status", { headers: this.headers(), signal }, directory);
        const statuses = await response.json();
        if (statuses?.[sessionId]?.type === "idle") return;
        consecutiveFailures = 0;
      } catch (error) {
        if (signal?.aborted || error.name === "AbortError") throw error;
        consecutiveFailures += 1;
        if (consecutiveFailures >= 3) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }

  async healthCheck() {
    try {
      const response = await this.checkedFetch("/global/health", { headers: this.headers(), signal: AbortSignal.timeout(5000) });
      return { status: "healthy", ...(await response.json()) };
    } catch (error) {
      return { status: "unhealthy", detail: error.message };
    }
  }

  async createSession({ logicalSessionId, directory, signal }) {
    const response = await this.checkedFetch("/session", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ title: logicalSessionId }),
      signal,
    }, directory || this.directory);
    const payload = await response.json();
    const id = payload.id ?? payload.sessionID ?? payload.data?.id;
    if (!id) throw new GatewayError("ENGINE_PROTOCOL_ERROR", "OpenCode create-session response has no session id", 502, payload);
    this.sessionDirectories.set(String(id), directory || this.directory);
    return { id: String(id), logicalSessionId };
  }

  async *run({ runId, engineSessionId, input, importedHistory = [], model, agent, signal }) {
    const directory = this.sessionDirectories.get(engineSessionId) ?? this.directory;
    const guidedInput = withRuntimeGuidance(input, "opencode");
    const contextualInput = importedHistory.length
      ? `以下是从其他引擎迁移的对话记录，仅作为上下文：\n${importedHistory.map((message) => `${message.role}: ${message.content}`).join("\n")}\n\n当前请求：${guidedInput}`
      : guidedInput;
    yield event("run.started", "opencode", runId, { engineSessionId });

    const eventController = new AbortController();
    const queue = new AsyncQueue();
    const abort = () => {
      queue.push({ kind: "requestError", error: signal?.reason ?? new DOMException("Aborted", "AbortError") });
      eventController.abort();
      void fetch(this.url(`/session/${encodeURIComponent(engineSessionId)}/abort`, directory), { method: "POST", headers: this.headers() }).catch(() => {});
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    let pump;
    let completedSuccessfully = false;
    try {
      const eventResponse = await this.checkedFetch("/event", {
        headers: this.headers({ Accept: "text/event-stream" }),
        signal: eventController.signal,
      }, directory, { timeoutMs: 10_000, connectionOnlyTimeout: true });
      pump = (async () => {
        try {
          for await (const item of parseSse(eventResponse.body)) {
            if (!item.data || item.data === "[DONE]") continue;
            try { queue.push({ kind: "event", payload: JSON.parse(item.data) }); }
            catch { /* Ignore keepalive or non-JSON diagnostic frames. */ }
          }
          if (!eventController.signal.aborted) queue.push({ kind: "streamError", error: new Error("OpenCode event stream closed") });
        } catch (error) {
          if (!eventController.signal.aborted) queue.push({ kind: "streamError", error });
        }
      })();

      const nativeAgent = openCodeAgentName(agent);
      const requestBody = { parts: [{ type: "text", text: contextualInput }], ...(nativeAgent ? { agent: nativeAgent } : {}) };
      const selectedModel = model?.providerID && model?.modelID ? model : (this.providerId && this.modelId
        ? { providerID: this.providerId, modelID: this.modelId }
        : null);
      if (selectedModel) requestBody.model = selectedModel;
      void this.checkedFetch(`/session/${encodeURIComponent(engineSessionId)}/prompt_async`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(requestBody),
        signal,
      }, directory, { timeoutMs: 0 }).then(() => queue.push({ kind: "accepted" }))
        .catch((error) => queue.push({ kind: "requestError", error }));

      let streamedText = "";
      let accepted = false;
      let completed = false;
      let sawActivity = false;
      let sawIdle = false;
      const toolStatuses = new Map();
      while (!completed) {
        const item = await queue.next();
        if (item.kind === "requestError") throw item.error;
        if (item.kind === "streamError") {
          yield event("run.warning", "opencode", runId, { message: `OpenCode event stream interrupted; falling back to status polling: ${item.error.message}` });
          await this.waitForSessionIdle(engineSessionId, directory, signal);
          completed = true;
          continue;
        }
        if (item.kind === "accepted") {
          accepted = true;
          if (sawActivity && sawIdle) completed = true;
          continue;
        }
        if (sessionIdOf(item.payload) !== engineSessionId) continue;
        if (item.payload?.type === "session.status" && item.payload.properties?.status?.type === "busy") sawActivity = true;
        if (["message.part.delta", "message.part.updated", "permission.asked", "question.asked"].includes(item.payload?.type)) sawActivity = true;
        const toolEvent = mapToolPart(item.payload, runId, toolStatuses);
        const mapped = toolEvent ?? mapOpenCodeEvent(item.payload, runId);
        if (mapped) {
          if (mapped.type === "permission.requested") {
            const requestId = mapped.data.permission?.id;
            if (!this.rememberInteraction("permission", requestId)) continue;
            if (this.permissionMode !== "ask") {
              await this.replyPermission(engineSessionId, requestId, {
                reply: this.permissionMode === "allow" ? "once" : "reject",
              });
              continue;
            }
          }
          if (mapped.type === "question.requested" && !this.rememberInteraction("question", mapped.data.question?.id)) continue;
          if (mapped.type === "message.delta") streamedText += mapped.data.delta ?? "";
          yield mapped;
        }
        if (accepted && item.payload?.type === "session.error") {
          const message = openCodeErrorMessage(item.payload.properties?.error);
          throw new GatewayError("ENGINE_ERROR", `OpenCode session failed: ${message}`, 502, item.payload.properties);
        }
        const isIdle = item.payload?.type === "session.idle"
          || (item.payload?.type === "session.status" && item.payload.properties?.status?.type === "idle");
        if (isIdle) {
          sawIdle = true;
          if (accepted) completed = true;
        }
      }

      const messagesResponse = await this.checkedFetch(`/session/${encodeURIComponent(engineSessionId)}/message`, {
        headers: this.headers(),
      }, directory);
      const messages = await messagesResponse.json();
      const result = Array.isArray(messages)
        ? [...messages].reverse().find((message) => message?.info?.role === "assistant" || message?.role === "assistant")
        : null;
      if (!result) throw new GatewayError("ENGINE_PROTOCOL_ERROR", "OpenCode completed without an assistant message", 502);
      const finalText = messageText(result);
      if (!streamedText && finalText) {
        yield event("message.delta", "opencode", runId, { delta: finalText, fallback: "synchronous-response" });
      } else if (finalText.startsWith(streamedText) && finalText.length > streamedText.length) {
        yield event("message.delta", "opencode", runId, { delta: finalText.slice(streamedText.length), fallback: "response-tail" });
      }
      yield event("message.completed", "opencode", runId, { text: finalText || streamedText });
      completedSuccessfully = true;
      yield event("run.completed", "opencode", runId, { finishReason: "stop" });
    } finally {
      eventController.abort();
      signal?.removeEventListener("abort", abort);
      if (!completedSuccessfully && !signal?.aborted) {
        void fetch(this.url(`/session/${encodeURIComponent(engineSessionId)}/abort`, directory), {
          method: "POST", headers: this.headers(), signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      }
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
    try {
      await this.checkedFetch(`/permission/${encodeURIComponent(requestId)}/reply`, {
        method: "POST", headers: this.headers(), body: JSON.stringify({ reply, ...(message ? { message } : {}) }),
      }, directory);
      return { ok: true };
    } catch (error) {
      if (/permission request not found|notfound|not found/i.test(error.message)) {
        return { ok: true, alreadyResolved: true };
      }
      throw error;
    }
  }
}
