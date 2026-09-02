import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createApp } from "../src/app.js";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "agent-gateway-test-"));
  const app = await createApp({ stateFile: join(directory, "state.json"), engineMode: "mock", port: 0 });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const { port } = app.server.address();
  return {
    app,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      app.server.close();
      await once(app.server, "close");
      await app.gateway.shutdown();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function post(url, payload) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  return { response, body: await response.json() };
}

test("same business conversation reuses the Pi engine binding", async () => {
  const f = await fixture();
  try {
    const request = { tenantId: "t1", conversationId: "group-a", engine: "pi" };
    const first = await post(`${f.baseUrl}/api/chat`, { ...request, input: "first" });
    const second = await post(`${f.baseUrl}/api/chat`, { ...request, input: "second" });
    assert.equal(first.response.status, 200);
    assert.match(first.body.output, /第 1 轮/);
    assert.match(second.body.output, /第 2 轮/);
    const session = f.app.gateway.getSession("t1", "group-a");
    assert.equal(Object.keys(session.bindings).length, 1);
    assert.equal(session.history.length, 4);
  } finally { await f.close(); }
});

test("switching to OpenCode keeps logical session and imports normalized history", async () => {
  const f = await fixture();
  try {
    await post(`${f.baseUrl}/api/chat`, { tenantId: "t1", conversationId: "group-a", engine: "pi", input: "project is Starbridge" });
    const before = f.app.gateway.getSession("t1", "group-a").logicalSessionId;
    const switched = await post(`${f.baseUrl}/api/sessions/group-a/switch`, { tenantId: "t1", engine: "opencode" });
    assert.equal(switched.body.previousEngine, "pi");
    const reply = await post(`${f.baseUrl}/api/chat`, { tenantId: "t1", conversationId: "group-a", input: "continue" });
    assert.match(reply.body.output, /opencode/);
    assert.match(reply.body.output, /已迁移 2 条历史消息/);
    const session = f.app.gateway.getSession("t1", "group-a");
    assert.equal(session.logicalSessionId, before);
    assert.deepEqual(Object.keys(session.bindings).sort(), ["opencode", "pi"]);
  } finally { await f.close(); }
});

test("different conversations have isolated logical and native sessions", async () => {
  const f = await fixture();
  try {
    await post(`${f.baseUrl}/api/chat`, { tenantId: "t1", conversationId: "group-a", engine: "pi", input: "A" });
    await post(`${f.baseUrl}/api/chat`, { tenantId: "t1", conversationId: "group-b", engine: "pi", input: "B" });
    const a = f.app.gateway.getSession("t1", "group-a");
    const b = f.app.gateway.getSession("t1", "group-b");
    assert.notEqual(a.logicalSessionId, b.logicalSessionId);
    assert.notEqual(a.bindings.pi.engineSessionId, b.bindings.pi.engineSessionId);
    assert.equal(a.history[0].content, "A");
    assert.equal(b.history[0].content, "B");
  } finally { await f.close(); }
});

test("engine allowlist is enforced by gateway", async () => {
  const f = await fixture();
  try {
    const result = await post(`${f.baseUrl}/api/chat`, {
      tenantId: "t1", conversationId: "restricted", engine: "opencode", allowedEngines: ["pi"], input: "blocked",
    });
    assert.equal(result.response.status, 403);
    assert.equal(result.body.error.code, "ENGINE_FORBIDDEN");
  } finally { await f.close(); }
});

test("OpenAI-compatible endpoint and official API console are available", async () => {
  const f = await fixture();
  try {
    const completion = await post(`${f.baseUrl}/v1/chat/completions`, {
      messages: [{ role: "user", content: "hello" }],
      metadata: { engine: "opencode" },
      conversationId: "openai-demo",
    });
    assert.equal(completion.response.status, 200);
    assert.equal(completion.body.object, "chat.completion");
    assert.match(completion.body.choices[0].message.content, /opencode/);
    const ui = await fetch(f.baseUrl);
    assert.equal(ui.status, 200);
    assert.match(await ui.text(), /评测接口对话控制台/);
    const runtime = await fetch(`${f.baseUrl}/api/engines`).then((response) => response.json());
    assert.equal(runtime.activeEngine, "pi");
    assert.equal(runtime.switchMode, "startup");
  } finally { await f.close(); }
});
