[CmdletBinding()]
param(
  [switch]$SkipPythonPackages
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version Latest

$NodeVersion = "22.23.2"
$NodeArchiveHash = "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97"
$PythonVersion = "3.12.10"
$PythonInstallerHash = "67b5635e80ea51072b87941312d00ec8927c4db9ba18938f7ad2d27b328b95fb"
$PiVersion = "0.84.4"
$OpenCodeVersion = "1.18.25"

$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$RuntimeRoot = Join-Path $ProjectRoot ".runtime"
$DownloadRoot = Join-Path $RuntimeRoot "downloads"
$NodeRoot = Join-Path $RuntimeRoot "node"
$PythonRoot = Join-Path $RuntimeRoot "python"
$NpmPrefix = Join-Path $RuntimeRoot "npm-global"
$CacheRoot = Join-Path $RuntimeRoot "cache"

function Assert-RuntimePath([string]$Path) {
  $resolvedRoot = [System.IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\') + '\'
  $resolvedPath = [System.IO.Path]::GetFullPath($Path)
  if (-not $resolvedPath.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to modify a path outside the private runtime: $resolvedPath"
  }
}

function Write-Step([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Get-Sha256([string]$Path) {
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
  } finally {
    $stream.Dispose()
    $algorithm.Dispose()
  }
}

function Get-VerifiedDownload([string]$Uri, [string]$Destination, [string]$ExpectedHash) {
  Assert-RuntimePath $Destination
  if (Test-Path -LiteralPath $Destination) {
    $currentHash = Get-Sha256 $Destination
    if ($currentHash -eq $ExpectedHash) {
      Write-Host "Using cached $([System.IO.Path]::GetFileName($Destination))"
      return
    }
    Remove-Item -LiteralPath $Destination -Force
  }
  Write-Host "Downloading $Uri"
  Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination
  $actualHash = Get-Sha256 $Destination
  if ($actualHash -ne $ExpectedHash) {
    Remove-Item -LiteralPath $Destination -Force
    throw "SHA-256 mismatch for $Uri (expected $ExpectedHash, got $actualHash)"
  }
}

function Get-ToolVersion([string]$Executable, [string[]]$Arguments) {
  if (-not (Test-Path -LiteralPath $Executable)) { return "" }
  $output = & $Executable @Arguments 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { return "" }
  return $output.Trim()
}

if (-not [Environment]::Is64BitOperatingSystem) {
  throw "The bootstrap currently supports 64-bit Windows 10/11 only."
}

New-Item -ItemType Directory -Force -Path $RuntimeRoot, $DownloadRoot, $CacheRoot | Out-Null

Write-Step "Preparing private Node.js v$NodeVersion"
$NodeExecutable = Join-Path $NodeRoot "node.exe"
$installedNode = Get-ToolVersion $NodeExecutable @("--version")
if ($installedNode -and $installedNode -ne "v$NodeVersion") {
  Write-Host "Replacing private Node $installedNode with v$NodeVersion"
  Assert-RuntimePath $NodeRoot
  Remove-Item -LiteralPath $NodeRoot -Recurse -Force
  $installedNode = ""
}
if (-not $installedNode) {
  $nodeArchiveName = "node-v$NodeVersion-win-x64.zip"
  $nodeArchive = Join-Path $DownloadRoot $nodeArchiveName
  Get-VerifiedDownload "https://nodejs.org/dist/v$NodeVersion/$nodeArchiveName" $nodeArchive $NodeArchiveHash
  $extractRoot = Join-Path $RuntimeRoot "node-extract"
  Assert-RuntimePath $extractRoot
  if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force }
  Expand-Archive -LiteralPath $nodeArchive -DestinationPath $extractRoot -Force
  $expandedNode = Join-Path $extractRoot "node-v$NodeVersion-win-x64"
  if (-not (Test-Path -LiteralPath (Join-Path $expandedNode "node.exe"))) { throw "Downloaded Node archive has an unexpected layout" }
  New-Item -ItemType Directory -Force -Path $NodeRoot | Out-Null
  Copy-Item -Path (Join-Path $expandedNode "*") -Destination $NodeRoot -Recurse -Force
  Remove-Item -LiteralPath $extractRoot -Recurse -Force
}
if ((Get-ToolVersion $NodeExecutable @("--version")) -ne "v$NodeVersion") { throw "Private Node validation failed" }

Write-Step "Preparing project-local Python $PythonVersion"
$PythonExecutable = Join-Path $PythonRoot "python.exe"
$installedPython = Get-ToolVersion $PythonExecutable @("--version")
if ($installedPython -and $installedPython -ne "Python $PythonVersion") {
  throw "Private Python version is $installedPython, expected Python $PythonVersion. Remove the project .runtime directory and rerun setup.cmd."
}
if (-not $installedPython) {
  $pythonInstallerName = "python-$PythonVersion-amd64.exe"
  $pythonInstaller = Join-Path $DownloadRoot $pythonInstallerName
  Get-VerifiedDownload "https://www.python.org/ftp/python/$PythonVersion/$pythonInstallerName" $pythonInstaller $PythonInstallerHash
  if (Get-Command Get-AuthenticodeSignature -ErrorAction SilentlyContinue) {
    $signature = Get-AuthenticodeSignature -LiteralPath $pythonInstaller
    if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Subject -notmatch "Python Software Foundation") {
      throw "Python installer signature validation failed: $($signature.Status) $($signature.SignerCertificate.Subject)"
    }
  } else {
    Write-Warning "Authenticode cmdlet is unavailable; relying on the pinned SHA-256 digest."
  }
  New-Item -ItemType Directory -Force -Path $PythonRoot | Out-Null
  $installerArguments = "/quiet InstallAllUsers=0 TargetDir=`"$PythonRoot`" Include_pip=1 Include_launcher=0 Include_test=0 Include_doc=0 Include_tcltk=0 AssociateFiles=0 Shortcuts=0 PrependPath=0 AppendPath=0"
  $installer = Start-Process -FilePath $pythonInstaller -ArgumentList $installerArguments -Wait -PassThru -WindowStyle Hidden
  if ($installer.ExitCode -notin @(0, 3010)) { throw "Python installer exited with code $($installer.ExitCode)" }
}
if ((Get-ToolVersion $PythonExecutable @("--version")) -ne "Python $PythonVersion") { throw "Private Python validation failed" }

$env:PATH = "$NodeRoot;$PythonRoot;$(Join-Path $PythonRoot 'Scripts');$NpmPrefix;$env:PATH"
$env:npm_config_prefix = $NpmPrefix
$env:npm_config_cache = Join-Path $CacheRoot "npm"
$env:PIP_CACHE_DIR = Join-Path $CacheRoot "pip"
$env:PIP_DISABLE_PIP_VERSION_CHECK = "1"
$NpmExecutable = Join-Path $NodeRoot "npm.cmd"

if (-not $SkipPythonPackages) {
  Write-Step "Installing pinned Python test dependencies"
  & $PythonExecutable -m pip install --requirement (Join-Path $ProjectRoot "requirements-test.txt")
  if ($LASTEXITCODE -ne 0) { throw "Python dependency installation failed" }
}

Write-Step "Installing Pi $PiVersion and OpenCode $OpenCodeVersion into the private npm prefix"
New-Item -ItemType Directory -Force -Path $NpmPrefix | Out-Null
$PiCommand = Join-Path $NpmPrefix "pi.cmd"
$OpenCodeCommand = Join-Path $NpmPrefix "opencode.cmd"
$actualPi = Get-ToolVersion $PiCommand @("--version")
$actualOpenCode = Get-ToolVersion $OpenCodeCommand @("--version")
if ($actualPi -notmatch [regex]::Escape($PiVersion)) {
  & $NpmExecutable install --global --ignore-scripts --no-audit --no-fund "@earendil-works/pi-coding-agent@$PiVersion"
  if ($LASTEXITCODE -ne 0) { throw "Pi installation failed" }
  $actualPi = Get-ToolVersion $PiCommand @("--version")
}
if ($actualOpenCode -notmatch [regex]::Escape($OpenCodeVersion)) {
  & $NpmExecutable install --global --no-audit --no-fund "opencode-ai@$OpenCodeVersion"
  if ($LASTEXITCODE -ne 0) { throw "OpenCode installation failed" }
  $actualOpenCode = Get-ToolVersion $OpenCodeCommand @("--version")
}
if ($actualPi -notmatch [regex]::Escape($PiVersion)) { throw "Pi validation failed: $actualPi" }
if ($actualOpenCode -notmatch [regex]::Escape($OpenCodeVersion)) { throw "OpenCode validation failed: $actualOpenCode" }

$manifest = [ordered]@{
  node = $NodeVersion
  python = $PythonVersion
  pi = $PiVersion
  opencode = $OpenCodeVersion
  preparedAt = (Get-Date).ToUniversalTime().ToString("o")
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RuntimeRoot "runtime.json") -Encoding UTF8

Write-Step "Private runtime is ready"
Write-Host "Node:     $NodeExecutable"
Write-Host "Python:   $PythonExecutable"
Write-Host "Pi:       $PiCommand ($actualPi)"
Write-Host "OpenCode: $OpenCodeCommand ($actualOpenCode)"
Write-Host "Next: copy .env.example to .env, edit the model settings, then run start.cmd"
