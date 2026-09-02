import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createApp } from "../src/app.js";

const directory = await mkdtemp(join(tmpdir(), "agent-gateway-demo-"));
const app = await createApp({ stateFile: join(directory, "state.json"), engineMode: process.env.ENGINE_MODE ?? "mock", port: 0 });
app.server.listen(0, "127.0.0.1");
await once(app.server, "listening");
const baseUrl = `http://127.0.0.1:${app.server.address().port}`;

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(payload));
  return payload;
}

try {
  console.log("1) Group A -> Pi");
  const first = await post("/api/chat", { tenantId: "contest", conversationId: "group-a", engine: "pi", input: "记住项目代号是星桥" });
  console.log(first.output);

  console.log("\n2) Switch the same business conversation -> OpenCode");
  await post("/api/sessions/group-a/switch", { tenantId: "contest", engine: "opencode" });
  const second = await post("/api/chat", { tenantId: "contest", conversationId: "group-a", input: "继续处理刚才的任务" });
  console.log(second.output);

  console.log("\n3) Session bindings");
  console.log(JSON.stringify(app.gateway.getSession("contest", "group-a"), null, 2));
} finally {
  app.server.close();
  await once(app.server, "close");
  await app.gateway.shutdown();
  await rm(directory, { recursive: true, force: true });
}
