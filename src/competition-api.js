import { randomUUID } from "node:crypto";
import { GatewayError, normalizeError } from "./core/errors.js";

const TENANT_ID = "contest-evaluator";

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new GatewayError("VALIDATION_ERROR", `${name} is required`, 400);
  }
  return value.trim();
}

export class CompetitionApi {
  constructor({ gateway, config }) {
    this.gateway = gateway;
    this.config = config;
    this.sessions = new Map();
    this.subscribers = new Set();
    this.abortControllers = new Map();
    this.questions = new Map();
    this.permissions = new Map();
  }

  isRoute(pathname) {
    return pathname === "/event" || pathname === "/question" || pathname === "/permission"
      || pathname.startsWith("/session") || pathname.startsWith("/question/") || pathname.startsWith("/permission/");
  }

  emit(type, properties = {}) {
    const payload = JSON.stringify({ type, properties });
    for (const response of this.subscribers) response.write(`data: ${payload}\n\n`);
  }

  session(id) {
    const session = this.sessions.get(id);
    if (!session) throw new GatewayError("NOT_FOUND", "Session not found", 404);
    return session;
  }

  publicSession(session, includeCount = false) {
    return {
      id: session.id,
      title: session.title,
      created_at: session.created_at,
      status: session.status,
      ...(includeCount ? { message_count: session.messages.length } : {}),
    };
  }

  publicInteraction(request) {
    const { _tenantId, _conversationId, ...payload } = request;
    return payload;
  }

  async handle(req, res, url, { readBody, sendJson }) {
    if (!this.isRoute(url.pathname)) return false;
    try {
      if (req.method === "GET" && url.pathname === "/event") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        this.subscribers.add(res);
        res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
        const heartbeat = setInterval(() => {
          if (!res.destroyed) res.write(`data: ${JSON.stringify({ type: "server.heartbeat", properties: {} })}\n\n`);
        }, 15_000);
        req.on("close", () => {
          clearInterval(heartbeat);
          this.subscribers.delete(res);
        });
        return true;
      }

      if (req.method === "POST" && url.pathname === "/session") {
        const payload = await readBody(req);
        const title = requiredText(payload.title, "title");
        const id = `ses_${randomUUID().replaceAll("-", "")}`;
        const directory = url.searchParams.get("directory") ?? "";
        const session = { id, title, directory, created_at: new Date().toISOString(), status: "idle", messages: [] };
        this.sessions.set(id, session);
        await this.gateway.ensureSession(TENANT_ID, id, { title, directory });
        sendJson(res, 200, this.publicSession(session));
        return true;
      }

      if (req.method === "GET" && url.pathname === "/session/status") {
        const statuses = {};
        for (const session of this.sessions.values()) statuses[session.id] = { type: session.status };
        sendJson(res, 200, statuses);
        return true;
      }

      const promptMatch = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
      if (req.method === "POST" && promptMatch) {
        const id = decodeURIComponent(promptMatch[1]);
        const payload = await readBody(req);
        await this.prompt(this.session(id), payload);
        res.writeHead(204).end();
        return true;
      }

      const messagesMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/);
      if (req.method === "GET" && messagesMatch) {
        sendJson(res, 200, this.session(decodeURIComponent(messagesMatch[1])).messages);
        return true;
      }

      const abortMatch = url.pathname.match(/^\/session\/([^/]+)\/(?:abort|stop)$/);
      if (req.method === "POST" && abortMatch) {
        const id = decodeURIComponent(abortMatch[1]);
        this.session(id);
        this.abortControllers.get(id)?.abort(new Error("Aborted by evaluator"));
        sendJson(res, 200, { ok: true });
        return true;
      }

      const sessionMatch = url.pathname.match(/^\/session\/([^/]+)$/);
      if (sessionMatch && req.method === "GET") {
        sendJson(res, 200, this.publicSession(this.session(decodeURIComponent(sessionMatch[1])), true));
        return true;
      }
      if (sessionMatch && req.method === "DELETE") {
        const id = decodeURIComponent(sessionMatch[1]);
        this.session(id);
        this.abortControllers.get(id)?.abort(new Error("Session deleted"));
        await this.gateway.deleteSession(TENANT_ID, id);
        this.sessions.delete(id);
        for (const [requestId, request] of this.questions) if (request.sessionID === id) this.questions.delete(requestId);
        for (const [requestId, request] of this.permissions) if (request.sessionID === id) this.permissions.delete(requestId);
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (req.method === "GET" && url.pathname === "/question") {
        sendJson(res, 200, [...this.questions.values()].map((request) => this.publicInteraction(request)));
        return true;
      }
      const questionReply = url.pathname.match(/^\/question\/([^/]+)\/reply$/);
      if (req.method === "POST" && questionReply) {
        const requestId = decodeURIComponent(questionReply[1]);
        const pending = this.questions.get(requestId);
        if (!pending) throw new GatewayError("NOT_FOUND", "Question request not found", 404);
        const payload = await readBody(req);
        if (!Array.isArray(payload.answers) || payload.answers.some((answer) => !Array.isArray(answer))) {
          throw new GatewayError("VALIDATION_ERROR", "answers must be an array of arrays", 400);
        }
        await this.gateway.replyQuestion(pending._tenantId, pending._conversationId, requestId, payload.answers);
        this.questions.delete(requestId);
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (req.method === "GET" && url.pathname === "/permission") {
        for (const [requestId, request] of this.permissions) {
          try {
            const pending = await this.gateway.isPermissionPending(request._tenantId, request._conversationId, requestId);
            if (!pending) this.permissions.delete(requestId);
          } catch { /* Keep the local request if OpenCode is temporarily unreachable. */ }
        }
        sendJson(res, 200, [...this.permissions.values()].map((request) => this.publicInteraction(request)));
        return true;
      }
      const permissionReply = url.pathname.match(/^\/permission\/([^/]+)\/reply$/);
      if (req.method === "POST" && permissionReply) {
        const requestId = decodeURIComponent(permissionReply[1]);
        const pending = this.permissions.get(requestId);
        if (!pending) throw new GatewayError("NOT_FOUND", "Permission request not found", 404);
        const payload = await readBody(req);
        if (!["once", "always", "reject"].includes(payload.reply)) {
          throw new GatewayError("VALIDATION_ERROR", "reply must be once, always, or reject", 400);
        }
        await this.gateway.replyPermission(pending._tenantId, pending._conversationId, requestId, payload.reply, payload.message);
        this.permissions.delete(requestId);
        sendJson(res, 200, { ok: true });
        return true;
      }

      throw new GatewayError("NOT_FOUND", "Route not found", 404);
    } catch (error) {
      const normalized = normalizeError(error);
      const code = ["VALIDATION_ERROR", "NOT_FOUND", "INTERNAL_ERROR", "BAD_GATEWAY", "SERVICE_UNAVAILABLE"].includes(normalized.code)
        ? normalized.code
        : normalized.status === 400 ? "VALIDATION_ERROR"
          : normalized.status === 404 ? "NOT_FOUND"
            : normalized.status === 503 ? "SERVICE_UNAVAILABLE"
              : normalized.status >= 500 ? "BAD_GATEWAY" : "INTERNAL_ERROR";
      if (!res.headersSent) sendJson(res, normalized.status, { code, message: normalized.message });
      else res.end();
      return true;
    }
  }

  async prompt(session, payload) {
    if (session.status === "busy") throw new GatewayError("VALIDATION_ERROR", "Session is busy", 400);
    if (!Array.isArray(payload.parts) || !payload.parts.length) {
      throw new GatewayError("VALIDATION_ERROR", "parts is required", 400);
    }
    if (payload.parts.some((part) => part?.type !== "text" || typeof part.text !== "string")) {
      throw new GatewayError("VALIDATION_ERROR", "parts currently supports text only", 400);
    }
    if (!payload.model || typeof payload.model.providerID !== "string" || typeof payload.model.modelID !== "string") {
      throw new GatewayError("VALIDATION_ERROR", "model.providerID and model.modelID are required", 400);
    }
    const input = payload.parts.map((part) => part.text).join("");
    requiredText(input, "parts[].text");
    const now = new Date().toISOString();
    session.messages.push({ id: `msg_${randomUUID()}`, role: "user", content: input, created_at: now });
    const assistant = {
      id: `msg_${randomUUID()}`,
      role: "assistant",
      content: "",
      tool_calls: [],
      created_at: now,
      info: { role: "assistant", finish: "stop" },
      parts: [],
    };
    session.status = "busy";
    this.emit("session.status", { sessionID: session.id, status: { type: "busy" } });
    const controller = new AbortController();
    this.abortControllers.set(session.id, controller);
    try {
      const stream = this.gateway.chat({
        tenantId: TENANT_ID,
        conversationId: session.id,
        input,
        engine: this.config.defaultEngine,
        directory: session.directory,
        model: payload.model,
        signal: controller.signal,
      });
      for await (const item of stream) this.consumeEngineEvent(session, assistant, item);
      assistant.parts.push({ type: "step-finish" });
      session.messages.push(assistant);
      this.emit("message.part.updated", {
        sessionID: session.id, messageID: assistant.id, part: { type: "step-finish" },
      });
      session.status = "idle";
      this.emit("session.status", { sessionID: session.id, status: { type: "idle" } });
      this.emit("session.idle", { sessionID: session.id });
    } catch (error) {
      session.status = "idle";
      const normalized = normalizeError(error);
      this.emit("session.error", {
        sessionID: session.id,
        error: { message: normalized.message, data: { responseBody: normalized.details ?? "" } },
      });
      throw error;
    } finally {
      this.abortControllers.delete(session.id);
    }
  }

  consumeEngineEvent(session, assistant, item) {
    if (item.type === "message.delta") {
      const content = item.data.delta ?? "";
      assistant.content += content;
      const part = { type: "text", content };
      assistant.parts.push(part);
      this.emit("message.part.updated", { sessionID: session.id, messageID: assistant.id, part });
      return;
    }
    if (item.type === "tool.started" || item.type === "tool.completed") {
      const callId = item.data.toolCallId ?? `call_${randomUUID()}`;
      const tool = item.data.toolName ?? item.data.tool ?? "tool";
      if (item.type === "tool.started") {
        assistant.tool_calls.push({ id: callId, name: tool, arguments: item.data.args ?? {} });
      }
      const part = {
        type: "tool", tool,
        state: { status: item.type === "tool.started" ? "running" : "completed", title: item.type === "tool.started" ? `正在执行 ${tool}` : `${tool} 执行完成` },
      };
      assistant.parts.push(part);
      this.emit("message.part.updated", { sessionID: session.id, messageID: assistant.id, part });
      return;
    }
    if (item.type === "question.requested") {
      const source = item.data.question ?? {};
      const id = source.id ?? `req_${randomUUID()}`;
      const request = { id, sessionID: session.id, questions: source.questions ?? [], created_at: new Date().toISOString(), _tenantId: TENANT_ID, _conversationId: session.id };
      this.questions.set(id, request);
      this.emit("question.asked", { sessionID: session.id, id, questions: request.questions });
      return;
    }
    if (item.type === "permission.requested") {
      const source = item.data.permission ?? {};
      const id = source.id ?? `perm_${randomUUID()}`;
      const request = {
        id, sessionID: session.id, permission: source.permission ?? source.type ?? "unknown",
        patterns: source.patterns ?? [], created_at: new Date().toISOString(), _tenantId: TENANT_ID, _conversationId: session.id,
      };
      this.permissions.set(id, request);
      this.emit("permission.asked", { sessionID: session.id, id, permission: request.permission, patterns: request.patterns });
      return;
    }
    if (item.type === "permission.resolved") this.permissions.delete(item.data.requestId);
    if (item.type === "question.resolved") this.questions.delete(item.data.requestId);
  }

  consumeExternalEvent({ tenantId, conversationId }, item) {
    if (item.type === "question.requested") {
      const source = item.data.question ?? {};
      const id = source.id ?? `req_${randomUUID()}`;
      const request = {
        id, sessionID: conversationId, questions: source.questions ?? [], created_at: new Date().toISOString(),
        _tenantId: tenantId, _conversationId: conversationId,
      };
      this.questions.set(id, request);
      this.emit("question.asked", { sessionID: conversationId, id, questions: request.questions });
    }
    if (item.type === "permission.requested") {
      const source = item.data.permission ?? {};
      const id = source.id ?? `perm_${randomUUID()}`;
      const request = {
        id, sessionID: conversationId, permission: source.permission ?? source.type ?? "unknown",
        patterns: source.patterns ?? [], created_at: new Date().toISOString(),
        _tenantId: tenantId, _conversationId: conversationId,
      };
      this.permissions.set(id, request);
      this.emit("permission.asked", { sessionID: conversationId, id, permission: request.permission, patterns: request.patterns });
      return;
    }
    if (item.type === "permission.resolved") this.permissions.delete(item.data.requestId);
    if (item.type === "question.resolved") this.questions.delete(item.data.requestId);
  }
}
