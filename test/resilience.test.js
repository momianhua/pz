import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { EngineRegistry } from "../src/engines/registry.js";
import { CircuitBreaker } from "../src/core/circuit-breaker.js";
import { GatewayError } from "../src/core/errors.js";
import { PiRpcAdapter } from "../src/adapters/pi-rpc-adapter.js";
import { OpenCodeHttpAdapter } from "../src/adapters/opencode-http-adapter.js";
import { AgentGateway } from "../src/core/gateway.js";

test("engine registry accepts a third engine without changing app construction", async () => {
  const calls = [];
  const adapter = {
    metadata: () => ({ name: "third" }), healthCheck: async () => ({ status: "healthy" }),
    createSession: async () => ({ id: "third-session" }), async *run() {},
  };
  const registry = new EngineRegistry().register({
    name: "third",
    createAdapter: () => adapter,
    createService: () => ({
      start: async () => calls.push("start"),
      stop: async () => calls.push("stop"),
    }),
  });
  const runtime = await registry.createRuntime({ defaultEngine: "third", engineMode: "real" });
  assert.equal(runtime.adapters[0], adapter);
  assert.deepEqual(registry.names(), ["third"]);
  assert.deepEqual(calls, ["start"]);
  await runtime.stop();
  assert.deepEqual(calls, ["start", "stop"]);
});

test("engine registry preserves explicit adapter overrides", async () => {
  const adapter = {
    metadata: () => ({ name: "custom" }), healthCheck: async () => ({ status: "healthy" }),
    createSession: async () => ({ id: "custom-session" }), async *run() {},
  };
  const runtime = await new EngineRegistry().createRuntime({ defaultEngine: "custom", engineMode: "real" }, [adapter]);
  assert.deepEqual(runtime.adapters, [adapter]);
});

test("engine registry rejects incomplete adapters before serving traffic", async () => {
  const adapter = { metadata: () => ({ name: "broken" }) };
  await assert.rejects(
    new EngineRegistry().createRuntime({ defaultEngine: "broken", engineMode: "real" }, [adapter]),
    /missing healthCheck/,
  );
});

test("engine registry stops an active service when adapter validation fails", async () => {
  let stopped = false;
  const registry = new EngineRegistry().register({
    name: "broken",
    createAdapter: () => ({ metadata: () => ({ name: "broken" }) }),
    createService: () => ({ start: async () => {}, stop: async () => { stopped = true; } }),
  });
  await assert.rejects(registry.createRuntime({ defaultEngine: "broken", engineMode: "real" }), /missing healthCheck/);
  assert.equal(stopped, true);
});

test("circuit breaker opens after repeated upstream failures and later permits one probe", () => {
  let now = 1000;
  const breaker = new CircuitBreaker({ name: "test", failureThreshold: 2, resetTimeoutMs: 100, now: () => now });
  breaker.assertAvailable();
  breaker.failure(new GatewayError("ENGINE_UNAVAILABLE", "failed", 503));
  breaker.assertAvailable();
  breaker.failure(new GatewayError("ENGINE_PROTOCOL_ERROR", "failed", 502));
  assert.equal(breaker.snapshot().state, "open");
  assert.throws(() => breaker.assertAvailable(), /temporarily unavailable/);
  now += 101;
  breaker.assertAvailable();
  assert.equal(breaker.snapshot().state, "half-open");
  assert.throws(() => breaker.assertAvailable(), /temporarily unavailable/);
  breaker.success();
  assert.deepEqual(breaker.snapshot(), { state: "closed", failures: 0 });
});

test("circuit breaker ignores task, capacity, cancellation, and local failures", () => {
  const breaker = new CircuitBreaker({ name: "test", failureThreshold: 1 });
  for (const error of [
    new GatewayError("ENGINE_ERROR", "model rejected the request", 502),
    new GatewayError("ENGINE_BUSY", "busy", 503),
    new GatewayError("RUN_ABORTED", "cancelled", 499),
    new GatewayError("STORE_ERROR", "disk full", 500),
  ]) breaker.failure(error);
  assert.deepEqual(breaker.snapshot(), { state: "closed", failures: 0 });
});

test("gateway rejects duplicate adapter names instead of silently replacing one", () => {
  const adapter = {
    metadata: () => ({ name: "duplicate" }),
    healthCheck: async () => ({ status: "healthy" }),
    createSession: async () => ({ id: "native" }),
    async *run() {},
  };
  assert.throws(
    () => new AgentGateway({ adapters: [adapter, adapter], store: {}, defaultEngine: "duplicate" }),
    /Duplicate engine adapter/,
  );
});

test("Pi run is released when its caller times out even if the subprocess is silent", async () => {
  const adapter = new PiRpcAdapter({
    piCommand: "pi", piAgentDir: "", piSessionRoot: "", piProvider: "", piModel: "",
    piProcessIdleMs: 1000, piMaxProcesses: 1,
  });
  let waiter;
  const fakeProcess = {
    engineSessionId: "pi-test", busy: false, invalidated: false, lastUsedAt: Date.now(), idleTimer: null,
    send() {}, stop() {}, stopTree() {},
    next: () => new Promise((resolve) => { waiter = resolve; }),
    push: (value) => waiter?.(value),
  };
  adapter.ensureProcess = async () => fakeProcess;
  adapter.scheduleRecycle = () => {};
  const controller = new AbortController();
  const iterator = adapter.run({ runId: "run-test", engineSessionId: "pi-test", input: "wait", signal: controller.signal });
  assert.equal((await iterator.next()).value.type, "run.started");
  const waiting = iterator.next();
  controller.abort(new Error("Gateway run timeout"));
  await assert.rejects(waiting, (error) => error.code === "ENGINE_TIMEOUT" && error.status === 504);
  assert.equal(fakeProcess.invalidated, true);
});

test("Pi timeout also interrupts a stalled model-selection response", async () => {
  const adapter = new PiRpcAdapter({
    piCommand: "pi", piAgentDir: "", piSessionRoot: "", piProvider: "", piModel: "",
    piProcessIdleMs: 1000, piMaxProcesses: 1,
  });
  let waiter;
  const fakeProcess = {
    engineSessionId: "pi-model", busy: false, invalidated: false, lastUsedAt: Date.now(), idleTimer: null,
    send() {}, stop() {}, async stopTree() {},
    next: () => new Promise((resolve) => { waiter = resolve; }),
    push: (value) => waiter?.(value),
  };
  adapter.ensureProcess = async () => fakeProcess;
  adapter.scheduleRecycle = () => {};
  const controller = new AbortController();
  const iterator = adapter.run({
    runId: "run-model", engineSessionId: "pi-model", input: "wait",
    model: { providerID: "provider", modelID: "model" }, signal: controller.signal,
  });
  assert.equal((await iterator.next()).value.type, "run.started");
  const waiting = iterator.next();
  controller.abort(new Error("Gateway run timeout"));
  await assert.rejects(waiting, (error) => error.code === "ENGINE_TIMEOUT" && error.status === 504);
  assert.equal(fakeProcess.invalidated, true);
});

test("Pi capacity waiters resume without returning a spurious engine failure", async () => {
  const adapter = new PiRpcAdapter({ piCommand: "pi", piAgentDir: "", piSessionRoot: "" });
  const controller = new AbortController();
  const available = adapter.waitForCapacity(controller.signal);
  assert.equal(adapter.capacityWaiters.length, 1);
  adapter.notifyCapacity();
  await available;
  assert.equal(adapter.capacityWaiters.length, 0);
  const cancelled = adapter.waitForCapacity(controller.signal);
  controller.abort(new Error("Gateway run timeout"));
  await assert.rejects(cancelled, /Gateway run timeout/);
  assert.equal(adapter.capacityWaiters.length, 0);
});

test("Pi shutdown waits for process-tree cleanup", async () => {
  const adapter = new PiRpcAdapter({ piCommand: "pi", piAgentDir: "", piSessionRoot: "" });
  let completed = false;
  adapter.processes.set("one", {
    stopTree: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      completed = true;
    },
  });
  await adapter.shutdown();
  assert.equal(completed, true);
  assert.equal(adapter.processes.size, 0);
});

test("gateway timeout does not depend on an adapter honoring AbortSignal", async () => {
  const sessions = new Map();
  const store = {
    key: (tenant, conversation) => `${tenant}:${conversation}`,
    get: (tenant, conversation) => sessions.get(`${tenant}:${conversation}`),
    put: async (session) => sessions.set(`${session.tenantId}:${session.conversationId}`, session),
  };
  const adapter = {
    metadata: () => ({ name: "silent" }),
    createSession: async () => ({ id: "silent-session" }),
    async *run() { await new Promise(() => {}); },
  };
  const gateway = new AgentGateway({ adapters: [adapter], store, defaultEngine: "silent", runTimeoutMs: 30 });
  const consume = async () => {
    for await (const _event of gateway.chat({ tenantId: "t", conversationId: "c", input: "wait" })) { /* no events */ }
  };
  await assert.rejects(consume(), (error) => error.code === "ENGINE_TIMEOUT" && error.status === 504);
});

test("gateway timeout also covers engine session creation", async () => {
  const sessions = new Map();
  const store = {
    key: (tenant, conversation) => `${tenant}:${conversation}`,
    get: (tenant, conversation) => sessions.get(`${tenant}:${conversation}`),
    put: async (session) => sessions.set(`${session.tenantId}:${session.conversationId}`, session),
  };
  const adapter = {
    metadata: () => ({ name: "silent-create" }),
    createSession: async () => new Promise(() => {}),
    async *run() {},
  };
  const gateway = new AgentGateway({ adapters: [adapter], store, defaultEngine: "silent-create", runTimeoutMs: 30 });
  const consume = async () => {
    for await (const _event of gateway.chat({ tenantId: "t", conversationId: "c", input: "wait" })) { /* no events */ }
  };
  await assert.rejects(consume(), (error) => error.code === "ENGINE_TIMEOUT" && error.status === 504);
});

test("local persistence errors do not count as engine circuit failures", async () => {
  const session = {
    logicalSessionId: "logical", tenantId: "t", conversationId: "c", activeEngine: "ok",
    bindings: { ok: { engineSessionId: "native" } }, history: [], directory: "", title: "test",
  };
  const store = {
    key: () => "t:c", get: () => session,
    put: async () => { throw new Error("disk full"); },
  };
  const adapter = {
    metadata: () => ({ name: "ok" }), createSession: async () => ({ id: "native" }),
    async *run() { yield { type: "message.completed", data: { text: "done" } }; },
  };
  const gateway = new AgentGateway({ adapters: [adapter], store, defaultEngine: "ok", runTimeoutMs: 1000 });
  const consume = async () => {
    for await (const _event of gateway.chat({ tenantId: "t", conversationId: "c", input: "run" })) { /* consume */ }
  };
  await assert.rejects(consume(), /disk full/);
  assert.deepEqual(gateway.breakers.get("ok").snapshot(), { state: "closed", failures: 0 });
});

test("a newly created native session is closed if its binding cannot be persisted", async () => {
  const session = {
    logicalSessionId: "logical", tenantId: "t", conversationId: "c", activeEngine: "ok",
    bindings: {}, history: [], directory: "", title: "test",
  };
  let closedSession;
  const store = {
    key: () => "t:c", get: () => session,
    put: async () => { throw new Error("disk full"); },
  };
  const adapter = {
    metadata: () => ({ name: "ok" }), createSession: async () => ({ id: "orphan" }),
    async *run() {}, closeSession: async (id) => { closedSession = id; },
  };
  const gateway = new AgentGateway({ adapters: [adapter], store, defaultEngine: "ok", runTimeoutMs: 1000 });
  const consume = async () => {
    for await (const _event of gateway.chat({ tenantId: "t", conversationId: "c", input: "run" })) { /* consume */ }
  };
  await assert.rejects(consume(), /disk full/);
  assert.equal(closedSession, "orphan");
  assert.deepEqual(session.bindings, {});
});

test("engine health probes are cached and adapter exceptions become unhealthy", async () => {
  let calls = 0;
  const adapter = {
    metadata: () => ({ name: "health" }),
    healthCheck: async () => { calls += 1; throw new Error("probe failed"); },
  };
  const gateway = new AgentGateway({ adapters: [adapter], store: {}, defaultEngine: "health" });
  const first = await gateway.health("health");
  const second = await gateway.health("health");
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.equal(first.status, "unhealthy");
});

test("OpenCode retries transient GET failures but never retries POST", async (t) => {
  let gets = 0;
  let posts = 0;
  const server = createServer((request, response) => {
    if (request.url.startsWith("/slow")) {
      setTimeout(() => { response.writeHead(200).end("ok"); }, 80);
      return;
    }
    if (request.method === "GET") {
      gets += 1;
      response.writeHead(gets < 3 ? 503 : 200, { "Content-Type": "application/json" });
      response.end(gets < 3 ? "temporary" : '{"healthy":true}');
      return;
    }
    posts += 1;
    response.writeHead(503).end("temporary");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const adapter = new OpenCodeHttpAdapter({
    openCodeBaseUrl: `http://127.0.0.1:${server.address().port}`,
    openCodeUsername: "", openCodePassword: "", openCodeDirectory: "",
    openCodeProviderId: "", openCodeModelId: "", openCodePermissionMode: "allow",
  });
  assert.equal((await adapter.healthCheck()).status, "healthy");
  assert.equal(gets, 3);
  await assert.rejects(adapter.checkedFetch("/mutate", { method: "POST" }), /503/);
  assert.equal(posts, 1);
  await assert.rejects(adapter.checkedFetch("/slow", { method: "POST" }, "", { timeoutMs: 20 }), /timeout/i);
  const slow = await adapter.checkedFetch("/slow", { method: "POST" }, "", { timeoutMs: 0 });
  assert.equal(await slow.text(), "ok");
});

test("OpenCode prompt execution may exceed the short control-request timeout", async (t) => {
  const streams = new Set();
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/event") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.flushHeaders();
      streams.add(response);
      request.on("close", () => streams.delete(response));
      return;
    }
    if (request.method === "POST" && url.pathname === "/session/native/prompt_async") {
      for (const stream of streams) stream.write('data: {"type":"session.status","properties":{"sessionID":"native","status":{"type":"busy"}}}\n\n');
      setTimeout(() => {
        for (const stream of streams) {
          stream.write('data: {"type":"message.part.delta","properties":{"sessionID":"native","field":"text","delta":"done"}}\n\n');
          stream.write('data: {"type":"session.idle","properties":{"sessionID":"native"}}\n\n');
        }
        response.writeHead(204).end();
      }, 80);
      return;
    }
    if (request.method === "GET" && url.pathname === "/session/native/message") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('[{"role":"assistant","parts":[{"type":"text","text":"done"}]}]');
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const adapter = new OpenCodeHttpAdapter({
    openCodeBaseUrl: `http://127.0.0.1:${server.address().port}`,
    openCodeUsername: "", openCodePassword: "", openCodeDirectory: "",
    openCodeProviderId: "", openCodeModelId: "", openCodePermissionMode: "allow",
    openCodeControlRequestTimeoutMs: 20,
  });
  const output = [];
  for await (const item of adapter.run({ runId: "long", engineSessionId: "native", input: "work", signal: new AbortController().signal })) {
    output.push(item);
  }
  assert.equal(output.find((item) => item.type === "message.completed")?.data.text, "done");
});
