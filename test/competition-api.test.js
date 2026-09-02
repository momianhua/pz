import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createApp } from "../src/app.js";
import { event } from "../src/core/events.js";

async function fixture(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "contest-api-test-"));
  const app = await createApp({ stateFile: join(directory, "state.json"), engineMode: "mock", defaultEngine: "pi", port: 0, ...overrides });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  return {
    app,
    directory,
    baseUrl: `http://127.0.0.1:${app.server.address().port}`,
    async close() {
      app.server.close();
      await once(app.server, "close");
      await app.gateway.shutdown();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function jsonRequest(url, init = {}) {
  const response = await fetch(url, init);
  const body = response.status === 204 ? null : await response.json();
  return { response, body };
}

test("official gateway lifecycle and completion contract", async () => {
  const f = await fixture();
  try {
    const connected = await fetch(`${f.baseUrl}/event`, { headers: { Accept: "text/event-stream" } });
    assert.equal(connected.status, 200);
    const eventReader = connected.body.getReader();
    const firstFrame = new TextDecoder().decode((await eventReader.read()).value);
    assert.match(firstFrame, /server\.connected/);
    await eventReader.cancel();

    const created = await jsonRequest(`${f.baseUrl}/session?directory=${encodeURIComponent(f.directory)}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "评测会话" }),
    });
    assert.equal(created.response.status, 200);
    assert.equal(created.body.status, "idle");
    assert.match(created.body.id, /^ses_/);

    const promptRequest = jsonRequest(`${f.baseUrl}/session/${created.body.id}/prompt_async`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: "你好" }],
        model: { providerID: "glm-provider", modelID: "glm-5.2" },
        agent: "assistant",
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const busyStatuses = await jsonRequest(`${f.baseUrl}/session/status`);
    assert.deepEqual(busyStatuses.body[created.body.id], { type: "busy" });
    const prompt = await promptRequest;
    assert.equal(prompt.response.status, 204);

    const messages = await jsonRequest(`${f.baseUrl}/session/${created.body.id}/message`);
    assert.equal(messages.body.length, 2);
    assert.equal(messages.body.at(-1).role, "assistant");
    assert.equal(messages.body.at(-1).info.finish, "stop");
    assert.ok(messages.body.at(-1).parts.some((part) => part.type === "step-finish"));

    const info = await jsonRequest(`${f.baseUrl}/session/${created.body.id}`);
    assert.equal(info.body.message_count, 2);
    assert.equal(info.body.status, "idle");
    const statuses = await jsonRequest(`${f.baseUrl}/session/status`);
    assert.deepEqual(statuses.body[created.body.id], { type: "idle" });
    assert.deepEqual((await jsonRequest(`${f.baseUrl}/question`)).body, []);
    assert.deepEqual((await jsonRequest(`${f.baseUrl}/permission`)).body, []);

    const aborted = await jsonRequest(`${f.baseUrl}/session/${created.body.id}/stop`, { method: "POST" });
    assert.deepEqual(aborted.body, { ok: true });
    const deleted = await jsonRequest(`${f.baseUrl}/session/${created.body.id}`, { method: "DELETE" });
    assert.deepEqual(deleted.body, { ok: true });
  } finally { await f.close(); }
});

test("official gateway errors use top-level code and message", async () => {
  const f = await fixture();
  try {
    const invalid = await jsonRequest(`${f.baseUrl}/session`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(invalid.response.status, 400);
    assert.deepEqual(invalid.body, { code: "VALIDATION_ERROR", message: "title is required" });
    const missing = await jsonRequest(`${f.baseUrl}/session/not-found`);
    assert.equal(missing.response.status, 404);
    assert.equal(missing.body.code, "NOT_FOUND");
  } finally { await f.close(); }
});

test("permission replies are idempotent and stale upstream requests are pruned", async () => {
  let run = 0;
  const adapter = {
    metadata: () => ({ name: "opencode", displayName: "OpenCode", transport: "test", mode: "real" }),
    healthCheck: async () => ({ status: "healthy" }),
    createSession: async () => ({ id: "native-session" }),
    async *run({ runId }) {
      run += 1;
      yield event("permission.requested", "opencode", runId, {
        permission: { id: `per-stale-${run}`, permission: "bash", patterns: ["echo *"] },
      });
      yield event("message.delta", "opencode", runId, { delta: "done" });
    },
    replyPermission: async () => ({ ok: true, alreadyResolved: true }),
    isPermissionPending: async (_sessionId, requestId) => requestId !== "per-stale-2",
    closeSession: async () => {},
    shutdown: async () => {},
  };
  const f = await fixture({ adapters: [adapter], defaultEngine: "opencode" });
  try {
    const created = await jsonRequest(`${f.baseUrl}/session`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "权限测试" }),
    });
    const send = () => jsonRequest(`${f.baseUrl}/session/${created.body.id}/prompt_async`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "test" }], model: { providerID: "p", modelID: "m" } }),
    });
    await send();
    const reply = await jsonRequest(`${f.baseUrl}/permission/per-stale-1/reply`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reply: "once" }),
    });
    assert.deepEqual(reply.body, { ok: true });
    assert.deepEqual((await jsonRequest(`${f.baseUrl}/permission`)).body, []);
    await send();
    assert.deepEqual((await jsonRequest(`${f.baseUrl}/permission`)).body, []);
  } finally { await f.close(); }
});
