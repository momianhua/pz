import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("Windows bootstrap reuses compatible tools and securely installs missing runtimes", async () => {
  const setup = await read("scripts/setup-runtime.ps1");
  assert.match(setup, /NodeVersion = "22\.23\.2"/);
  assert.match(setup, /PythonVersion = "3\.12\.10"/);
  assert.match(setup, /PiVersion = "0\.84\.4"/);
  assert.match(setup, /OpenCodeVersion = "1\.18\.25"/);
  assert.match(setup, /Security\.Cryptography\.SHA256/);
  assert.match(setup, /Get-AuthenticodeSignature/);
  assert.match(setup, /InstallAllUsers=0/);
  assert.match(setup, /npm-global/);
  assert.match(setup, /Find-Application/);
  assert.match(setup, /Find-CompatiblePython/);
  assert.match(setup, /Invoke-NativeCapture/);
  assert.match(setup, /python-install\.log/);
  assert.match(setup, /Invoke-NativeQuiet/);
  assert.match(setup, /expectedPackages/);
  assert.match(setup, /requirements-test\.txt must use exact package pins/);
  assert.match(setup, /importExitCode = Invoke-NativeQuiet/);
  assert.match(setup, /22\.19\.0/);
  assert.match(setup, /Npm-ForNode/);
  assert.match(setup, /Has-ExactVersion/);
  assert.match(setup, /RUNTIME_PACKAGE_DIR/);
  assert.match(setup, /InstallGlobalCommand/);
  assert.match(setup, /Install-GatewayCommand/);
  assert.match(setup, /POST_SETUP_SCRIPT/);
  assert.match(setup, /Invoke-PostSetupScript/);
  assert.match(setup, /Post-setup script failed with exit code/);
  assert.match(setup, /--upgrade --target/);
  assert.doesNotMatch(setup, /Copy-Item.*\.env\.example/);
  assert.match(setup, /Keeping existing \.env unchanged/);
});

test("Windows native probes use exit codes and keep Node paired with adjacent npm", {
  skip: process.platform !== "win32",
}, async () => {
  const source = await read("scripts/setup-runtime.ps1");
  const helpers = source.split("# Setup execution starts here.")[0];
  const temporary = await mkdtemp(join(tmpdir(), "gateway-setup-test-"));
  const tools = join(temporary, "tools");
  const runtime = join(temporary, "runtime");
  const downloads = join(runtime, "downloads");
  const project = join(temporary, "项目 code");
  const globalBin = join(temporary, "global-bin");
  await mkdir(tools);
  await mkdir(downloads, { recursive: true });
  await mkdir(project);
  await writeFile(join(project, "gateway.cmd"), "@echo off\r\necho project gateway %*\r\n");
  await writeFile(join(project, "internal install.bat"), "@echo off\r\necho post-setup-ok\r\nexit /b 0\r\n");
  await writeFile(join(tools, "node.cmd"), "@echo off\r\necho v22.23.2\r\n");
  await writeFile(join(tools, "npm.cmd"), "@echo off\r\necho npm warn unknown user config no_proxy 1>&2\r\necho 10.9.8\r\n");
  const offlineContent = "verified-offline-package";
  await writeFile(join(tools, "offline.bin"), offlineContent);
  const offlineHash = createHash("sha256").update(offlineContent).digest("hex");
  const escapedTools = tools.replaceAll("'", "''");
  const escapedRuntime = runtime.replaceAll("'", "''");
  const escapedProject = project.replaceAll("'", "''");
  const escapedGlobalBin = globalBin.replaceAll("'", "''");
  const probe = `${helpers}\n$Runtime='${escapedRuntime}'\n$Root='${escapedProject}'\n$PackageDirectory='${escapedTools}'\n$quiet = Invoke-NativeQuiet -exe $env:ComSpec -arguments @('/d','/c','echo expected 1>&2 & exit /b 7')\n$paired = Npm-ForNode '${escapedTools}\\node.cmd'\n$npmVersion = Version-Of $paired\n$exact = Has-ExactVersion '${escapedTools}\\node.cmd' '22.23.2'\nAcquire-Verified 'https://invalid.example/offline.bin' (Join-Path $Runtime 'downloads\\offline.bin') '${offlineHash}' 'offline.bin'\n$global = Install-GatewayCommand '${escapedGlobalBin}' $false\nInvoke-PostSetupScript '.\\internal install.bat'\nWrite-Output \"quiet=$quiet\"\nWrite-Output \"paired=$([IO.Path]::GetFileName($paired))\"\nWrite-Output \"npmVersion=$npmVersion\"\nWrite-Output \"exact=$exact\"\nWrite-Output \"offline=$([bool](Test-Path (Join-Path $Runtime 'downloads\\offline.bin')))\"\nWrite-Output \"global=$([bool](Test-Path $global))\"\n`;
  const probePath = join(temporary, "probe.ps1");
  // Windows PowerShell 5.1 needs a UTF-8 BOM to decode non-ASCII script paths.
  await writeFile(probePath, `\uFEFF${probe}`);
  try {
    const powershell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", probePath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /quiet=7/);
    assert.match(result.stdout, /paired=npm\.cmd/i);
    assert.match(result.stdout, /npmVersion=10\.9\.8/i);
    assert.doesNotMatch(result.stdout, /NativeCommandError/i);
    assert.match(result.stdout, /exact=True/i);
    assert.match(result.stdout, /offline=True/i);
    assert.match(result.stdout, /global=True/i);
    assert.match(result.stdout, /post-setup-ok/i);
    const globalScript = await readFile(join(globalBin, "gateway.ps1"), "utf8");
    assert.match(globalScript, /pz-agent-gateway managed launcher/);
    assert.match(globalScript, /项目 code/);
    const globalRun = spawnSync(process.env.ComSpec, ["/d", "/c", "gateway --engine opencode"], {
      cwd: temporary,
      encoding: "utf8",
      env: { ...process.env, PATH: `${globalBin};${process.env.PATH}` },
    });
    assert.equal(globalRun.status, 0, globalRun.stderr);
    assert.match(globalRun.stdout, /project gateway --engine opencode/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("launchers consume the environment selected by setup", async () => {
  const environment = await read("scripts/runtime-env.cmd");
  const start = await read("start.cmd");
  const gateway = await read("gateway.cmd");
  const ignore = await read(".gitignore");
  assert.match(environment, /RUNTIME_ENV_FILE/);
  assert.match(environment, /call "%RUNTIME_ENV_FILE%"/);
  assert.match(environment, /Configured Python is unavailable/);
  assert.match(environment, /Configured Pi is unavailable/);
  assert.match(environment, /Configured OpenCode is unavailable/);
  assert.match(start, /%NODE_COMMAND%/);
  assert.match(gateway, /start\.cmd/);
  assert.match(ignore, /^\.runtime\/$/m);
});
