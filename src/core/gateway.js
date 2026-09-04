import { randomUUID } from "node:crypto";
import { GatewayError, normalizeError } from "./errors.js";
import { SessionLock } from "./session-lock.js";
import { CircuitBreaker } from "./circuit-breaker.js";

function abortError(signal) {
  const reason = signal.reason;
  const timedOut = reason instanceof Error && /timeout/i.test(reason.message);
  return new GatewayError(timedOut ? "ENGINE_TIMEOUT" : "RUN_ABORTED", reason?.message ?? "Run aborted", timedOut ? 504 : 499);
}

async function* untilAborted(iterable, signal) {
  const iterator = iterable[Symbol.asyncIterator]();
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(abortError(signal));
  if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const result = await Promise.race([iterator.next(), aborted]);
      if (result.done) return;
      yield result.value;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    if (signal.aborted) void iterator.return?.().catch?.(() => {});
  }
}

async function untilResolvedOrAborted(operation, signal) {
  if (signal.aborted) throw abortError(signal);
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(abortError(signal));
  signal.addEventListener("abort", abort, { once: true });
  try { return await Promise.race([Promise.resolve().then(operation), aborted]); }
  finally { signal.removeEventListener("abort", abort); }
}

export class AgentGateway {
  constructor({ adapters, store, defaultEngine = "pi", runTimeoutMs = 120_000 }) {
    this.adapters = new Map();
    for (const adapter of adapters) {
      const name = adapter.metadata().name;
      if (this.adapters.has(name)) throw new Error(`Duplicate engine adapter: ${name}`);
      this.adapters.set(name, adapter);
    }
    this.store = store;
    this.defaultEngine = defaultEngine;
    this.runTimeoutMs = runTimeoutMs;
    this.locks = new SessionLock();
    this.breakers = new Map([...this.adapters.keys()].map((name) => [name, new CircuitBreaker({ name })]));
    this.healthCache = new Map();
    if (!this.adapters.has(defaultEngine)) throw new Error(`Unknown default engine: ${defaultEngine}`);
  }

  engines() {
    return [...this.adapters.values()].map((adapter) => {
      const metadata = adapter.metadata();
      return { ...metadata, circuitBreaker: this.breakers.get(metadata.name)?.snapshot() };
    });
  }

  getSession(tenantId, conversationId) {
    return this.store.get(tenantId, conversationId);
  }

  async health(name, maxAgeMs = 3000) {
    const adapter = this.adapters.get(name);
    if (!adapter) throw new GatewayError("ENGINE_NOT_FOUND", `Unknown engine: ${name}`, 404);
    const cached = this.healthCache.get(name);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;
    const promise = Promise.resolve()
      .then(() => adapter.healthCheck())
      .catch((error) => ({ status: "unhealthy", detail: normalizeError(error).message }));
    this.healthCache.set(name, { expiresAt: Date.now() + maxAgeMs, promise });
    return promise;
  }

  async ensureSession(tenantId, conversationId, attributes = {}) {
    let session = this.store.get(tenantId, conversationId);
    if (!session) {
      const now = new Date().toISOString();
      session = {
        logicalSessionId: `ls_${randomUUID()}`,
        tenantId,
        conversationId,
        activeEngine: this.defaultEngine,
        bindings: {},
        history: [],
        title: attributes.title ?? conversationId,
        directory: attributes.directory ?? "",
        createdAt: now,
        updatedAt: now,
      };
      await this.store.put(session);
    }
    if (attributes.title) session.title = attributes.title;
    if (attributes.directory !== undefined) session.directory = attributes.directory;
    return session;
  }

  async switchEngine(tenantId, conversationId, engine) {
    if (!this.adapters.has(engine)) throw new GatewayError("ENGINE_NOT_FOUND", `Unknown engine: ${engine}`, 404);
    const key = this.store.key(tenantId, conversationId);
    return this.locks.run(key, async () => {
      const session = await this.ensureSession(tenantId, conversationId);
      const previousEngine = session.activeEngine;
      session.activeEngine = engine;
      await this.store.put(session);
      return { ...session, previousEngine };
    });
  }

  async *chat({ tenantId, conversationId, input, engine, allowedEngines, signal, directory, model, agent }) {
    if (!tenantId || !conversationId || !input?.trim()) {
      throw new GatewayError("INVALID_REQUEST", "tenantId, conversationId and input are required", 400);
    }
    const key = this.store.key(tenantId, conversationId);
    const release = await this.locks.acquire(key);
    let timeout;
    let abortFromCaller;
    try {
      const session = await this.ensureSession(tenantId, conversationId, { directory });
      const selectedEngine = engine ?? session.activeEngine ?? this.defaultEngine;
      if (!this.adapters.has(selectedEngine)) throw new GatewayError("ENGINE_NOT_FOUND", `Unknown engine: ${selectedEngine}`, 404);
      if (allowedEngines?.length && !allowedEngines.includes(selectedEngine)) {
        throw new GatewayError("ENGINE_FORBIDDEN", `Engine ${selectedEngine} is not allowed for this caller`, 403);
      }
      if (engine && engine !== session.activeEngine) session.activeEngine = engine;

      const adapter = this.adapters.get(selectedEngine);
      const breaker = this.breakers.get(selectedEngine);
      breaker.assertAvailable();
      const controller = new AbortController();
      abortFromCaller = () => controller.abort(signal?.reason);
      if (signal?.aborted) abortFromCaller();
      else signal?.addEventListener("abort", abortFromCaller, { once: true });
      timeout = setTimeout(() => controller.abort(new Error("Gateway run timeout")), this.runTimeoutMs);
      let binding = session.bindings[selectedEngine];
      let importedHistory = [];
      if (!binding) {
        let created;
        try {
          created = await untilResolvedOrAborted(() => adapter.createSession({
            logicalSessionId: session.logicalSessionId, tenantId, conversationId, directory: session.directory, signal: controller.signal,
          }), controller.signal);
        } catch (error) {
          const normalized = normalizeError(error);
          breaker.failure(normalized);
          throw normalized;
        }
        binding = {
          engineSessionId: created.id,
          createdAt: new Date().toISOString(),
          importedHistoryCount: session.history.length,
        };
        session.bindings[selectedEngine] = binding;
        importedHistory = session.history.slice();
        try {
          await this.store.put(session);
        } catch (error) {
          delete session.bindings[selectedEngine];
          await Promise.resolve(adapter.closeSession?.(binding.engineSessionId)).catch(() => {});
          breaker.releaseProbe();
          throw error;
        }
      }

      try {
        const runId = `run_${randomUUID()}`;
        let assistantText = "";
        const engineEvents = adapter.run({
          runId,
          engineSessionId: binding.engineSessionId,
          logicalSessionId: session.logicalSessionId,
          input: input.trim(),
          importedHistory,
          model,
          agent,
          signal: controller.signal,
        });
        for await (const item of untilAborted(engineEvents, controller.signal)) {
          if (item.type === "message.delta") assistantText += item.data.delta ?? "";
          if (item.type === "message.completed" && !assistantText) assistantText = item.data.text ?? "";
          yield item;
        }
        breaker.success();
        session.history.push(
          { role: "user", content: input.trim(), engine: selectedEngine, createdAt: new Date().toISOString() },
          { role: "assistant", content: assistantText, engine: selectedEngine, createdAt: new Date().toISOString() },
        );
      } catch (error) {
        const normalized = normalizeError(error);
        breaker.failure(normalized);
        throw normalized;
      }
      await this.store.put(session);
    } finally {
      clearTimeout(timeout);
      if (abortFromCaller) signal?.removeEventListener("abort", abortFromCaller);
      release();
    }
  }

  async replyQuestion(tenantId, conversationId, requestId, answers) {
    return this.#replyInteraction(tenantId, conversationId, "replyQuestion", requestId, { answers });
  }

  async replyPermission(tenantId, conversationId, requestId, reply, message) {
    return this.#replyInteraction(tenantId, conversationId, "replyPermission", requestId, { reply, message });
  }

  async isPermissionPending(tenantId, conversationId, requestId) {
    const session = this.store.get(tenantId, conversationId);
    if (!session) return false;
    const adapter = this.adapters.get(session.activeEngine);
    const binding = session.bindings[session.activeEngine];
    if (!binding || typeof adapter?.isPermissionPending !== "function") return true;
    return adapter.isPermissionPending(binding.engineSessionId, requestId);
  }

  async #replyInteraction(tenantId, conversationId, method, requestId, payload) {
    const session = this.store.get(tenantId, conversationId);
    if (!session) throw new GatewayError("NOT_FOUND", "Session not found", 404);
    const adapter = this.adapters.get(session.activeEngine);
    const binding = session.bindings[session.activeEngine];
    if (!binding || typeof adapter?.[method] !== "function") {
      throw new GatewayError("NOT_FOUND", "Interaction request not found", 404);
    }
    await adapter[method](binding.engineSessionId, requestId, payload);
    return { ok: true };
  }

  async deleteSession(tenantId, conversationId) {
    const key = this.store.key(tenantId, conversationId);
    await this.locks.run(key, async () => {
      const session = this.store.get(tenantId, conversationId);
      if (!session) return;
      await Promise.allSettled(Object.entries(session.bindings).map(([name, binding]) => this.adapters.get(name)?.closeSession(binding.engineSessionId)));
      await this.store.delete(tenantId, conversationId);
    });
  }

  async shutdown() {
    this.healthCache.clear();
    await Promise.allSettled([...this.adapters.values()].map((adapter) => adapter.shutdown?.()));
  }
}
