/**
 * Engine Adapter SPI.
 * Implementations translate a stable gateway contract into engine-native calls.
 */
export class EngineAdapter {
  metadata() { throw new Error("metadata() is required"); }
  async healthCheck() { throw new Error("healthCheck() is required"); }
  async createSession() { throw new Error("createSession() is required"); }
  async *run() { throw new Error("run() is required"); }
  async closeSession() {}
  async replyQuestion() { throw new Error("Questions are not supported by this engine"); }
  async replyPermission() { throw new Error("Permissions are not supported by this engine"); }
  async shutdown() {}
}
