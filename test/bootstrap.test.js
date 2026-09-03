import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("Windows bootstrap pins and verifies all private runtimes", async () => {
  const setup = await read("scripts/setup-runtime.ps1");
  assert.match(setup, /NodeVersion = "22\.23\.2"/);
  assert.match(setup, /PythonVersion = "3\.12\.10"/);
  assert.match(setup, /PiVersion = "0\.84\.4"/);
  assert.match(setup, /OpenCodeVersion = "1\.18\.25"/);
  assert.match(setup, /System\.Security\.Cryptography\.SHA256/);
  assert.match(setup, /Get-AuthenticodeSignature/);
  assert.match(setup, /InstallAllUsers=0/);
  assert.match(setup, /npm-global/);
});

test("launchers default to project-private Node, Python, Pi and OpenCode", async () => {
  const environment = await read("scripts/runtime-env.cmd");
  const start = await read("start.cmd");
  const ignore = await read(".gitignore");
  assert.match(environment, /PRIVATE_NODE%\\node\.exe/);
  assert.match(environment, /PYTHON_COMMAND=.*PRIVATE_PYTHON/);
  assert.match(environment, /PI_COMMAND=.*PRIVATE_NPM_PREFIX/);
  assert.match(environment, /OPENCODE_COMMAND=.*PRIVATE_NPM_PREFIX/);
  assert.match(start, /%NODE_COMMAND%/);
  assert.match(ignore, /^\.runtime\/$/m);
});
