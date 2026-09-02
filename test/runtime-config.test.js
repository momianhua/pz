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
    piAgentDir: join(root, "pi-agent"),
  };
  try {
    await prepareLocalModelRuntime(config);
    const pi = JSON.parse(await readFile(join(root, "pi-agent", "models.json"), "utf8"));
    assert.equal(pi.providers["local-8017"].baseUrl, "http://127.0.0.1:8017/v1");
    assert.equal(pi.providers["local-8017"].apiKey, "$LOCAL_MODEL_API_KEY");
    assert.equal(pi.providers["local-8017"].models[0].id, "deepseek");

    const openCode = JSON.parse(openCodeInlineConfig(config));
    assert.equal(openCode.provider["local-8017"].options.baseURL, "http://127.0.0.1:8017/v1");
    assert.equal(openCode.provider["local-8017"].options.apiKey, "{env:LOCAL_MODEL_API_KEY}");
    assert.equal(openCode.permission.bash, "ask");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
