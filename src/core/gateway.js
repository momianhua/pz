import { randomUUID } from "node:crypto";
import { GatewayError, normalizeError } from "./errors.js";
import { SessionLock } from "./session-lock.js";

export class AgentGateway {
  constructor({ adapters, store, defaultEngine = "pi", runTimeoutMs = 120_000 }) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.metadata().name, adapter]));
    this.store = store;
    this.defaultEngine = defaultEngine;
    this.runTimeoutMs = runTimeoutMs;
    this.locks = new SessionLock();
    if (!this.adapters.has(defaultEngine)) throw new Error(`Unknown default engine: ${defaultEngine}`);
  }

  engines() {
    return [...this.adapters.values()].map((adapter) => adapter.metadata());
  }

  getSession(tenantId, conversationId) {
    return this.store.get(tenantId, conversationId);
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

  async *chat({ tenantId, conversationId, input, engine, allowedEngines, signal, directory, model }) {
    if (!tenantId || !conversationId || !input?.trim()) {
      throw new GatewayError("INVALID_REQUEST", "tenantId, conversationId and input are required", 400);
    }
    const key = this.store.key(tenantId, conversationId);
    const release = await this.locks.acquire(key);
    let timeout;
    try {
      const session = await this.ensureSession(tenantId, conversationId, { directory });
      const selectedEngine = engine ?? session.activeEngine ?? this.defaultEngine;
      if (!this.adapters.has(selectedEngine)) throw new GatewayError("ENGINE_NOT_FOUND", `Unknown engine: ${selectedEngine}`, 404);
      if (allowedEngines?.length && !allowedEngines.includes(selectedEngine)) {
        throw new GatewayError("ENGINE_FORBIDDEN", `Engine ${selectedEngine} is not allowed for this caller`, 403);
      }
      if (engine && engine !== session.activeEngine) session.activeEngine = engine;

      const adapter = this.adapters.get(selectedEngine);
      let binding = session.bindings[selectedEngine];
      let importedHistory = [];
      if (!binding) {
        const created = await adapter.createSession({ logicalSessionId: session.logicalSessionId, tenantId, conversationId, directory: session.directory });
        binding = {
          engineSessionId: created.id,
          createdAt: new Date().toISOString(),
          importedHistoryCount: session.history.length,
        };
        session.bindings[selectedEngine] = binding;
        importedHistory = session.history.slice();
        await this.store.put(session);
      }

      const runId = `run_${randomUUID()}`;
      const controller = new AbortController();
      const abortFromCaller = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abortFromCaller, { once: true });
      timeout = setTimeout(() => controller.abort(new Error("Gateway run timeout")), this.runTimeoutMs);
      let assistantText = "";
      try {
        for await (const item of adapter.run({
          runId,
          engineSessionId: binding.engineSessionId,
          logicalSessionId: session.logicalSessionId,
          input: input.trim(),
          importedHistory,
          model,
          signal: controller.signal,
        })) {
          if (item.type === "message.delta") assistantText += item.data.delta ?? "";
          if (item.type === "message.completed" && !assistantText) assistantText = item.data.text ?? "";
          yield item;
        }
      } catch (error) {
        throw normalizeError(error);
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abortFromCaller);
      }

      session.history.push(
        { role: "user", content: input.trim(), engine: selectedEngine, createdAt: new Date().toISOString() },
        { role: "assistant", content: assistantText, engine: selectedEngine, createdAt: new Date().toISOString() },
      );
      await this.store.put(session);
    } finally {
      clearTimeout(timeout);
      release();
    }
  }

  async replyQuestion(tenantId, conversationId, requestId, answers) {
    return this.#replyInteraction(tenantId, conversationId, "replyQuestion", requestId, { answers });
  }

  async replyPermission(tenantId, conversationId, requestId, reply, message) {
    return this.#replyInteraction(tenantId, conversationId, "replyPermission", requestId, { reply, message });
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
    await Promise.allSettled([...this.adapters.values()].map((adapter) => adapter.shutdown()));
  }
}
