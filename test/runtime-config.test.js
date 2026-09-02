import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCodeInlineConfig, prepareLocalModelRuntime } from "../src/runtime-config.js";

test("local model env creates project-scoped Pi and inline OpenCode configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "gateway-local-model-"));
  const config = {
    localModelBaseUrl: "http://127.0.0.1:8017/v1/",
    localModelProviderId: "local-8017",
    localModelId: "deepseek",
    localModelContextWindow: 32768,
    localModelMaxTokens: 8192,
    openCodePermissionMode: "ask",
    localModelAuthHeader: "Auth",
    piAgentDir: join(root, "pi-agent"),
  };
  try {
    await prepareLocalModelRuntime(config);
    const pi = JSON.parse(await readFile(join(root, "pi-agent", "models.json"), "utf8"));
    assert.equal(pi.providers["local-8017"].baseUrl, "http://127.0.0.1:8017/v1");
    assert.equal(pi.providers["local-8017"].apiKey, "$LOCAL_MODEL_API_KEY");
    assert.equal(pi.providers["local-8017"].authHeader, false);
    assert.equal(pi.providers["local-8017"].headers.Auth, "$LOCAL_MODEL_AUTH_VALUE");
    assert.equal(pi.providers["local-8017"].models[0].id, "deepseek");

    const openCode = JSON.parse(openCodeInlineConfig(config));
    assert.equal(openCode.provider["local-8017"].options.baseURL, "http://127.0.0.1:8017/v1");
    assert.equal(openCode.provider["local-8017"].options.apiKey, undefined);
    assert.equal(openCode.provider["local-8017"].options.headers.Auth, "{env:LOCAL_MODEL_AUTH_VALUE}");
    assert.equal(openCode.permission["*"], "ask");
    assert.equal(openCode.permission.question, "allow");
    assert.equal(JSON.parse(openCodeInlineConfig({ ...config, openCodePermissionMode: "allow" })).permission, "allow");
    assert.equal(JSON.parse(openCodeInlineConfig({ ...config, localModelBaseUrl: "" })).permission["*"], "ask");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
