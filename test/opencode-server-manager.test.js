import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { OpenCodeServerManager } from "../src/opencode-server-manager.js";

test("managed OpenCode startup rejects a stale server without the configured local model", async () => {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url.startsWith("/global/health")) response.end('{"healthy":true}');
    else if (request.url.startsWith("/provider")) response.end('{"all":[]}');
    else { response.statusCode = 404; response.end("{}"); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const manager = new OpenCodeServerManager({
    openCodeAutostart: true,
    openCodeBaseUrl: `http://127.0.0.1:${server.address().port}`,
    openCodeDirectory: process.cwd(),
    openCodeUsername: "opencode",
    openCodePassword: "",
    localModelBaseUrl: "http://127.0.0.1:8017/v1",
    localModelProviderId: "local-8017",
    localModelId: "qwen3.8",
  });
  try {
    await assert.rejects(manager.start(), (error) => {
      assert.equal(error.code, "ENGINE_CONFIG_CONFLICT");
      assert.match(error.message, /without local-8017\/qwen3\.8/);
      return true;
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});
