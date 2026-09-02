import { randomUUID } from "node:crypto";
import { EngineAdapter } from "./adapter.js";
import { event } from "../core/events.js";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class MockAdapter extends EngineAdapter {
  constructor(name, { latencyMs = 18 } = {}) {
    super();
    this.name = name;
    this.latencyMs = latencyMs;
    this.turns = new Map();
  }

  metadata() {
    return {
      name: this.name,
      displayName: this.name === "pi" ? "Pi Agent" : "OpenCode",
      transport: this.name === "pi" ? "JSONL/RPC subprocess" : "HTTP/OpenAPI + SSE",
      mode: "mock",
      capabilities: {
        streaming: true,
        sessions: true,
        toolCalling: true,
        cancellation: false,
        contextImport: true,
      },
    };
  }

  async healthCheck() {
    return { status: "healthy", mode: "mock" };
  }

  async createSession({ logicalSessionId }) {
    const id = `${this.name}_${randomUUID()}`;
    this.turns.set(id, 0);
    return { id, logicalSessionId };
  }

  async *run({ runId, engineSessionId, input, importedHistory = [] }) {
    const turn = (this.turns.get(engineSessionId) ?? 0) + 1;
    this.turns.set(engineSessionId, turn);
    const migrated = importedHistory.length > 0
      ? `，已迁移 ${importedHistory.length} 条历史消息`
      : "";
    const personality = this.name === "pi"
      ? "我通过 JSONL/RPC 适配器处理请求"
      : "我通过 HTTP/OpenAPI + SSE 适配器处理请求";
    const response = `[${this.name}] ${personality}。这是本引擎会话的第 ${turn} 轮${migrated}。你说：${input}`;

    yield event("run.started", this.name, runId, { engineSessionId });
    for (const token of response.match(/.{1,7}/gu) ?? []) {
      await delay(this.latencyMs);
      yield event("message.delta", this.name, runId, { delta: token });
    }
    yield event("message.completed", this.name, runId, { text: response });
    yield event("run.completed", this.name, runId, { finishReason: "stop" });
  }

  async closeSession(sessionId) {
    this.turns.delete(sessionId);
  }
}
