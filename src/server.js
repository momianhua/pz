#!/usr/bin/env node
import { createApp } from "./app.js";

const app = await createApp();
app.server.listen(app.config.port, app.config.host, () => {
  console.log(`Agent Gateway engine=${app.config.defaultEngine} mode=${app.config.engineMode} listening on http://${app.config.host}:${app.config.port}`);
  if (app.skillRuntime.count) console.log(`Loaded skills (${app.skillRuntime.count}): ${app.skillRuntime.names.join(", ")}`);
});

async function shutdown(signal) {
  console.log(`\nReceived ${signal}; shutting down...`);
  app.server.close();
  await app.gateway.shutdown();
  app.openCodeServer.stop();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
