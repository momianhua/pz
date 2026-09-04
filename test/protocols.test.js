import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import { createServer } from "node:http";
import { once } from "node:events";
import { attachStrictJsonlReader, mapPiEvent } from "../src/adapters/pi-rpc-adapter.js";
import { OpenCodeHttpAdapter, mapOpenCodeEvent, openCodeAgentName, openCodeErrorMessage, parseSse } from "../src/adapters/opencode-http-adapter.js";
import { collectEvents } from "../src/core/events.js";

test("Pi JSONL parser splits only on LF and preserves Unicode separators", async () => {
  const stream = new PassThrough();
  const values = [];
  const errors = [];
  attachStrictJsonlReader(stream, (value) => values.push(value), (error) => errors.push(error));
  stream.end('{"text":"left\u2028right"}\r\n{"ok":true}\n');
  await new Promise((resolve) => stream.on("end", resolve));
  assert.deepEqual(values, [{ text: "left right" }, { ok: true }]);
  assert.equal(errors.length, 0);
});

test("Pi and OpenCode native deltas map to the same canonical event", () => {
  const pi = mapPiEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } }, "r1");
  const opencode = mapOpenCodeEvent({ type: "message.part.delta", properties: { sessionID: "s1", field: "text", delta: "hi" } }, "r2");
  assert.equal(pi.type, "message.delta");
  assert.equal(opencode.type, "message.delta");
  assert.equal(pi.data.delta, opencode.data.delta);
});

test("OpenCode nested session errors remain readable", () => {
  const nested = {
    name: "ProviderAuthError",
    data: { error: { message: "401 invalid authentication header" } },
  };
  assert.equal(openCodeErrorMessage(nested), "ProviderAuthError: 401 invalid authentication header");
  const mapped = mapOpenCodeEvent({ type: "session.error", properties: { error: nested } }, "r-error");
  assert.equal(mapped.data.message, "ProviderAuthError: 401 invalid authentication header");
  assert.doesNotMatch(mapped.data.message, /\[object Object\]/);
});

test("gateway assistant role uses OpenCode's configured default agent", () => {
  assert.equal(openCodeAgentName("assistant"), undefined);
  assert.equal(openCodeAgentName(" ASSISTANT "), undefined);
  assert.equal(openCodeAgentName(undefined), undefined);
  assert.equal(openCodeAgentName("build"), "build");
  assert.equal(openCodeAgentName("general"), "general");
});

test("OpenCode SSE parser supports named events and multiline data", async () => {
  const source = Readable.from([Buffer.from('event: message\r\ndata: {"type":"message.part.delta",\r\ndata: "properties":{"delta":"hello"}}\r\n\r\n')]);
  const events = [];
  for await (const item of parseSse(source)) events.push(item);
  assert.deepEqual(events, [{ event: "message", data: '{"type":"message.part.delta",\n"properties":{"delta":"hello"}}' }]);
});

test("OpenCode run exits when the gateway aborts while waiting for events", async () => {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/event") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.flushHeaders();
      response.write('data: {"type":"server.connected","properties":{}}\n\n');
      return;
    }
    if (request.method === "POST" && url.pathname === "/session/ses-abort/prompt_async") {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/session/ses-abort/abort") {
      response.end('{"ok":true}');
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const adapter = new OpenCodeHttpAdapter({
    openCodeBaseUrl: `http://127.0.0.1:${server.address().port}`,
    openCodeUsername: "opencode", openCodePassword: "", openCodeDirectory: process.cwd(),
    openCodeProviderId: "provider", openCodeModelId: "model", openCodePermissionMode: "allow",
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("Gateway run timeout")), 200);
  try {
    await assert.rejects(async () => {
      for await (const _item of adapter.run({ runId: "run-abort", engineSessionId: "ses-abort", input: "wait", signal: controller.signal })) {
        // Consume until the abort is observed.
      }
    }, /Gateway run timeout/);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});

test("OpenCode adapter filters global events and combines SSE with final response", async () => {
  const eventClients = new Set();
  let deleted = false;
  let permissionReplies = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    assert.equal(url.searchParams.get("directory"), "C:\\contest");
    assert.equal(request.headers.authorization, `Basic ${Buffer.from("opencode:secret").toString("base64")}`);
    if (request.method === "GET" && url.pathname === "/global/health") {
      response.setHeader("Content-Type", "application/json");
      response.end('{"healthy":true,"version":"test"}');
      return;
    }
    if (request.method === "POST" && url.pathname === "/session") {
      response.setHeader("Content-Type", "application/json");
      response.end('{"id":"ses-test"}');
      return;
    }
    if (request.method === "GET" && url.pathname === "/event") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.flushHeaders();
      eventClients.add(response);
      request.on("close", () => eventClients.delete(response));
      response.write('data: {"type":"server.connected","properties":{}}\n\n');
      return;
    }
    if (request.method === "POST" && url.pathname === "/session/ses-test/prompt_async") {
      let body = "";
      for await (const chunk of request) body += chunk;
      assert.match(body, /当前请求/);
      for (const client of eventClients) {
        client.write('data: {"type":"session.status","properties":{"sessionID":"ses-test","status":{"type":"busy"}}}\n\n');
        client.write('data: {"type":"message.part.delta","properties":{"sessionID":"another-session","field":"text","delta":"leak"}}\n\n');
        client.write('data: {"type":"message.part.delta","properties":{"sessionID":"ses-test","field":"text","delta":"hello "}}\n\n');
        client.write('data: {"type":"message.part.delta","properties":{"sessionID":"ses-test","field":"text","delta":"world"}}\n\n');
        client.write('data: {"type":"permission.asked","properties":{"id":"per-test","sessionID":"ses-test","permission":"bash","patterns":["echo *"]}}\n\n');
      }
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/permission/per-test/reply") {
      permissionReplies += 1;
      for (const client of eventClients) {
        client.write('data: {"type":"permission.replied","properties":{"permissionID":"per-test","sessionID":"ses-test","response":"once"}}\n\n');
        client.write('data: {"type":"session.idle","properties":{"sessionID":"ses-test"}}\n\n');
      }
      response.setHeader("Content-Type", "application/json");
      response.end('{"ok":true}');
      return;
    }
    if (request.method === "POST" && url.pathname === "/permission/already-done/reply") {
      response.statusCode = 404;
      response.end("permission request not found: already-done");
      return;
    }
    if (request.method === "GET" && url.pathname === "/session/ses-test/message") {
      response.setHeader("Content-Type", "application/json");
      response.end('[{"info":{"role":"user"},"parts":[{"type":"text","text":"continue"}]},{"info":{"role":"assistant"},"parts":[{"type":"text","text":"hello world"}]}]');
      return;
    }
    if (request.method === "GET" && url.pathname === "/permission") {
      response.setHeader("Content-Type", "application/json");
      response.end("[]");
      return;
    }
    if (request.method === "DELETE" && url.pathname === "/session/ses-test") {
      deleted = true;
      response.end("true");
      return;
    }
    response.statusCode = 404;
    response.end("missing");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const adapter = new OpenCodeHttpAdapter({
    openCodeBaseUrl: `http://127.0.0.1:${server.address().port}`,
    openCodeUsername: "opencode",
    openCodePassword: "secret",
    openCodeDirectory: "C:\\contest",
    openCodeProviderId: "",
    openCodeModelId: "",
    openCodePermissionMode: "allow",
  });
  try {
    const health = await adapter.healthCheck();
    assert.equal(health.status, "healthy");
    const session = await adapter.createSession({ logicalSessionId: "logical-test" });
    assert.equal(session.id, "ses-test");
    const result = await collectEvents(adapter.run({
      runId: "run-test",
      engineSessionId: session.id,
      input: "continue",
      importedHistory: [{ role: "user", content: "previous" }],
    }));
    assert.equal(result.text, "hello world");
    assert.doesNotMatch(result.text, /leak/);
    assert.equal(result.events.filter((item) => item.type === "message.delta").length, 2);
    assert.equal(result.events.filter((item) => item.type === "permission.requested").length, 0);
    assert.equal(permissionReplies, 1);
    assert.deepEqual(await adapter.replyPermission(session.id, "already-done", { reply: "once" }), { ok: true, alreadyResolved: true });
    await adapter.closeSession(session.id);
    assert.equal(deleted, true);
  } finally {
    for (const client of eventClients) client.end();
    server.close();
    await once(server, "close");
  }
});
