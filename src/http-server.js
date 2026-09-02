import { createServer as createNodeServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectEvents } from "./core/events.js";
import { GatewayError, normalizeError } from "./core/errors.js";
import { CompetitionApi } from "./competition-api.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  res.end(body);
}

async function bodyJson(req, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new GatewayError("BODY_TOO_LARGE", "Request body is too large", 413);
    chunks.push(chunk);
  }
  if (!length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new GatewayError("INVALID_JSON", "Request body must be valid JSON", 400); }
}

function auth(req, config) {
  if (!config.gatewayApiKey) return;
  if (req.headers.authorization !== `Bearer ${config.gatewayApiKey}`) {
    throw new GatewayError("UNAUTHORIZED", "Missing or invalid bearer token", 401);
  }
}

function requestContext(req, payload = {}) {
  return {
    tenantId: String(payload.tenantId ?? req.headers["x-tenant-id"] ?? "demo-tenant"),
    conversationId: String(payload.conversationId ?? req.headers["x-conversation-id"] ?? "demo-conversation"),
    engine: payload.engine ?? req.headers["x-agent-engine"] ?? undefined,
    allowedEngines: payload.allowedEngines,
  };
}

async function serveStatic(pathname, res) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!/^[a-zA-Z0-9._/-]+$/.test(relative) || relative.includes("..")) return false;
  try {
    const content = await readFile(join(PUBLIC_DIR, relative));
    res.writeHead(200, { "Content-Type": MIME[extname(relative)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(content);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function createHttpServer({ gateway, config }) {
  const competition = new CompetitionApi({ gateway, config });
  return createNodeServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/app."))) {
        if (await serveStatic(url.pathname, res)) return;
      }
      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, { status: "ok", engines: gateway.engines().map(({ name, mode }) => ({ name, mode })) });
      }

      if (await competition.handle(req, res, url, {
        readBody: (request) => bodyJson(request, config.maxBodyBytes),
        sendJson: json,
      })) return;

      auth(req, config);

      if (req.method === "GET" && url.pathname === "/api/engines") {
        const engines = await Promise.all(gateway.engines().map(async (metadata) => ({ ...metadata, health: await gateway.adapters.get(metadata.name).healthCheck() })));
        return json(res, 200, { engines });
      }

      if (req.method === "GET" && url.pathname === "/api/sessions") {
        return json(res, 200, { sessions: gateway.store.list() });
      }

      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessionMatch && req.method === "GET") {
        const tenantId = url.searchParams.get("tenantId") ?? "demo-tenant";
        const conversationId = decodeURIComponent(sessionMatch[1]);
        const session = gateway.getSession(tenantId, conversationId);
        if (!session) throw new GatewayError("SESSION_NOT_FOUND", "Session not found", 404);
        return json(res, 200, session);
      }
      if (sessionMatch && req.method === "DELETE") {
        const tenantId = url.searchParams.get("tenantId") ?? "demo-tenant";
        await gateway.deleteSession(tenantId, decodeURIComponent(sessionMatch[1]));
        res.writeHead(204).end();
        return;
      }

      const switchMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/switch$/);
      if (switchMatch && req.method === "POST") {
        const payload = await bodyJson(req, config.maxBodyBytes);
        const tenantId = String(payload.tenantId ?? "demo-tenant");
        const result = await gateway.switchEngine(tenantId, decodeURIComponent(switchMatch[1]), payload.engine);
        return json(res, 200, result);
      }

      if (req.method === "POST" && ["/api/chat", "/api/chat/stream"].includes(url.pathname)) {
        const payload = await bodyJson(req, config.maxBodyBytes);
        const context = requestContext(req, payload);
        const abortController = new AbortController();
        res.on("close", () => { if (!res.writableFinished) abortController.abort(); });
        const engineStream = gateway.chat({ ...context, input: String(payload.input ?? ""), signal: abortController.signal });
        const stream = (async function* observeInteractions() {
          for await (const item of engineStream) {
            competition.consumeExternalEvent(context, item);
            yield item;
          }
        })();
        if (url.pathname.endsWith("/stream")) {
          res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
          try {
            for await (const item of stream) res.write(`event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`);
            res.write("event: done\ndata: {}\n\n");
          } catch (error) {
            const normalized = normalizeError(error);
            res.write(`event: error\ndata: ${JSON.stringify({ error: { code: normalized.code, message: normalized.message } })}\n\n`);
          }
          res.end();
          return;
        }
        const result = await collectEvents(stream);
        return json(res, 200, { engine: context.engine, output: result.text, events: result.events });
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const payload = await bodyJson(req, config.maxBodyBytes);
        const context = requestContext(req, { ...payload, engine: payload.engine ?? payload.metadata?.engine });
        const lastUser = [...(payload.messages ?? [])].reverse().find((message) => message.role === "user");
        const input = typeof lastUser?.content === "string" ? lastUser.content : "";
        const engineStream = gateway.chat({ ...context, input });
        const observedStream = (async function* observeInteractions() {
          for await (const item of engineStream) {
            competition.consumeExternalEvent(context, item);
            yield item;
          }
        })();
        const result = await collectEvents(observedStream);
        const session = gateway.getSession(context.tenantId, context.conversationId);
        return json(res, 200, {
          id: `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: session?.activeEngine ?? config.defaultEngine,
          choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: "stop" }],
        });
      }

      if (await serveStatic(url.pathname, res)) return;
      throw new GatewayError("NOT_FOUND", "Route not found", 404);
    } catch (error) {
      const normalized = normalizeError(error);
      if (!res.headersSent) json(res, normalized.status, { error: { code: normalized.code, message: normalized.message, details: normalized.details } });
      else res.end();
    }
  });
}
