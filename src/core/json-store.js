import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const EMPTY_STATE = { version: 1, sessions: {} };

export class JsonSessionStore {
  constructor(path) {
    this.path = resolve(path);
    this.state = structuredClone(EMPTY_STATE);
    this.writeQueue = Promise.resolve();
  }

  async load() {
    try {
      this.state = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await mkdir(dirname(this.path), { recursive: true });
    }
    return this;
  }

  key(tenantId, conversationId) {
    return `${encodeURIComponent(tenantId)}::${encodeURIComponent(conversationId)}`;
  }

  get(tenantId, conversationId) {
    return this.state.sessions[this.key(tenantId, conversationId)] ?? null;
  }

  list() {
    return Object.values(this.state.sessions);
  }

  async put(session) {
    session.updatedAt = new Date().toISOString();
    this.state.sessions[this.key(session.tenantId, session.conversationId)] = session;
    await this.persist();
    return session;
  }

  async delete(tenantId, conversationId) {
    delete this.state.sessions[this.key(tenantId, conversationId)];
    await this.persist();
  }

  async persist() {
    const snapshot = JSON.stringify(this.state, null, 2);
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, snapshot, "utf8");
      await rename(temporary, this.path);
    });
    return this.writeQueue;
  }
}
