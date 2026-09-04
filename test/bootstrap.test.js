import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("Windows bootstrap reuses compatible tools and securely installs missing runtimes", async () => {
  const setup = await read("scripts/setup-runtime.ps1");
  assert.match(setup, /NodeVersion = "22\.23\.2"/);
  assert.match(setup, /PythonVersion = "3\.12\.10"/);
  assert.match(setup, /PiVersion = "0\.84\.4"/);
  assert.match(setup, /OpenCodeVersion = "1\.18\.25"/);
  assert.match(setup, /Get-FileHash.*SHA256/);
  assert.match(setup, /Get-AuthenticodeSignature/);
  assert.match(setup, /InstallAllUsers=0/);
  assert.match(setup, /npm-global/);
  assert.match(setup, /Find-Application/);
  assert.match(setup, /Find-CompatiblePython/);
  assert.match(setup, /python-install\.log/);
  assert.match(setup, /22\.19\.0/);
  assert.match(setup, /Copy-Item.*\.env\.example/);
});

test("launchers consume the environment selected by setup", async () => {
  const environment = await read("scripts/runtime-env.cmd");
  const start = await read("start.cmd");
  const gateway = await read("gateway.cmd");
  const ignore = await read(".gitignore");
  assert.match(environment, /RUNTIME_ENV_FILE/);
  assert.match(environment, /call "%RUNTIME_ENV_FILE%"/);
  assert.match(start, /%NODE_COMMAND%/);
  assert.match(gateway, /start\.cmd/);
  assert.match(ignore, /^\.runtime\/$/m);
});
