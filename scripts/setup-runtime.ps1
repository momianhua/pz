[CmdletBinding()]
param([switch]$SkipPythonPackages)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version Latest

$NodeVersion = "22.23.2"
$NodeHash = "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97"
$PythonVersion = "3.12.10"
$PythonHash = "67b5635e80ea51072b87941312d00ec8927c4db9ba18938f7ad2d27b328b95fb"
$PiVersion = "0.84.4"
$OpenCodeVersion = "1.18.25"
$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$Runtime = Join-Path $Root ".runtime"
$Downloads = Join-Path $Runtime "downloads"
$NodeRoot = Join-Path $Runtime "node"
$PythonRoot = Join-Path $Runtime "python"
$PythonPackages = Join-Path $Runtime "python-packages"
$NpmPrefix = Join-Path $Runtime "npm-global"
$Cache = Join-Path $Runtime "cache"

function Step([string]$text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Assert-RuntimePath([string]$path) {
  $runtimePrefix = [IO.Path]::GetFullPath($Runtime).TrimEnd('\') + '\'
  $resolved = [IO.Path]::GetFullPath($path)
  if (-not $resolved.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to modify a path outside the project runtime: $resolved"
  }
}
function Version-Of([string]$exe) {
  if (-not $exe -or -not (Test-Path -LiteralPath $exe)) { return "" }
  $value = & $exe --version 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { return "" }
  return $value.Trim()
}
function Parsed-Version([string]$text) {
  if ($text -match '(\d+\.\d+\.\d+)') { return [version]$Matches[1] }
  return $null
}
function Find-Application([string[]]$names) {
  foreach ($name in $names) {
    $found = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.Source }
  }
  return ""
}
function Find-CompatiblePython {
  $candidates = [Collections.Generic.List[string]]::new()
  $pathPython = Find-Application @("python.exe", "python")
  if ($pathPython) { [void]$candidates.Add($pathPython) }

  $launcher = Find-Application @("py.exe", "py")
  if ($launcher) {
    $registered = & $launcher -0p 2>$null | Out-String
    foreach ($match in [regex]::Matches($registered, '[A-Za-z]:\\[^\r\n]*?python\.exe')) {
      [void]$candidates.Add($match.Value.Trim())
    }
  }

  foreach ($registryRoot in @(
    'HKCU:\Software\Python\PythonCore',
    'HKLM:\Software\Python\PythonCore',
    'HKLM:\Software\WOW6432Node\Python\PythonCore'
  )) {
    if (-not (Test-Path $registryRoot)) { continue }
    foreach ($versionKey in Get-ChildItem $registryRoot -ErrorAction SilentlyContinue) {
      $installKeyPath = Join-Path $versionKey.PSPath 'InstallPath'
      if (-not (Test-Path $installKeyPath)) { continue }
      $installKey = Get-Item $installKeyPath
      $properties = Get-ItemProperty $installKeyPath
      $executableProperty = $properties.PSObject.Properties['ExecutablePath']
      if ($executableProperty -and $executableProperty.Value) {
        [void]$candidates.Add([string]$executableProperty.Value)
      } else {
        $installDirectory = [string]$installKey.GetValue('')
        if ($installDirectory) { [void]$candidates.Add((Join-Path $installDirectory 'python.exe')) }
      }
    }
  }

  foreach ($candidate in $candidates | Select-Object -Unique) {
    if ((Parsed-Version (Version-Of $candidate)) -ge [version]"3.12.10") { return $candidate }
  }
  return ""
}
function Hash-Of([string]$path) {
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Download-Verified([string]$uri, [string]$target, [string]$hash) {
  Assert-RuntimePath $target
  if ((Test-Path -LiteralPath $target) -and (Hash-Of $target) -eq $hash) {
    Write-Host "Using cached $([IO.Path]::GetFileName($target))"
    return
  }
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
  Write-Host "Downloading $uri"
  Invoke-WebRequest -UseBasicParsing -Uri $uri -OutFile $target
  if ((Hash-Of $target) -ne $hash) {
    Remove-Item -LiteralPath $target -Force
    throw "SHA-256 mismatch for $uri"
  }
}

if (-not [Environment]::Is64BitOperatingSystem) { throw "Only 64-bit Windows 10/11 is supported." }
New-Item -ItemType Directory -Force -Path $Runtime, $Downloads, $Cache | Out-Null

Step "Detecting Node.js"
$privateNode = Join-Path $NodeRoot "node.exe"
$node = ""
$nodeSource = ""
if ((Parsed-Version (Version-Of $privateNode)) -ge [version]"22.19.0") {
  $node = $privateNode; $nodeSource = "project-private"
} else {
  $candidate = Find-Application @("node.exe", "node")
  if ((Parsed-Version (Version-Of $candidate)) -ge [version]"22.19.0") {
    $node = $candidate; $nodeSource = "system"
  }
}
if (-not $node) {
  Write-Host "Compatible Node.js is missing; installing private v$NodeVersion"
  $archiveName = "node-v$NodeVersion-win-x64.zip"
  $archive = Join-Path $Downloads $archiveName
  Download-Verified "https://nodejs.org/dist/v$NodeVersion/$archiveName" $archive $NodeHash
  $extract = Join-Path $Runtime "node-extract"
  Assert-RuntimePath $extract
  Assert-RuntimePath $NodeRoot
  if (Test-Path $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
  if (Test-Path $NodeRoot) { Remove-Item -LiteralPath $NodeRoot -Recurse -Force }
  Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force
  New-Item -ItemType Directory -Force -Path $NodeRoot | Out-Null
  Copy-Item (Join-Path $extract "node-v$NodeVersion-win-x64\*") $NodeRoot -Recurse -Force
  Remove-Item -LiteralPath $extract -Recurse -Force
  $node = $privateNode; $nodeSource = "downloaded-private"
}
$nodeVersion = Version-Of $node
if (-not $nodeVersion) { throw "Node.js validation failed" }
Write-Host "Using $nodeVersion ($nodeSource): $node"

Step "Detecting Python"
$privatePython = Join-Path $PythonRoot "python.exe"
$python = ""
$pythonSource = ""
if ((Parsed-Version (Version-Of $privatePython)) -ge [version]"3.12.10") {
  $python = $privatePython; $pythonSource = "project-private"
} else {
  $candidate = Find-CompatiblePython
  if ($candidate) {
    $python = $candidate; $pythonSource = "system"
  }
}
if (-not $python) {
  Write-Host "Compatible Python is missing; installing private $PythonVersion"
  $installerName = "python-$PythonVersion-amd64.exe"
  $installerPath = Join-Path $Downloads $installerName
  Download-Verified "https://www.python.org/ftp/python/$PythonVersion/$installerName" $installerPath $PythonHash
  $signature = Get-AuthenticodeSignature -LiteralPath $installerPath
  if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Subject -notmatch "Python Software Foundation") {
    throw "Python installer signature validation failed: $($signature.Status)"
  }
  Assert-RuntimePath $PythonRoot
  if (Test-Path -LiteralPath $PythonRoot) { Remove-Item -LiteralPath $PythonRoot -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $PythonRoot | Out-Null
  $installLog = Join-Path $Runtime "python-install.log"
  $arguments = "/quiet /log `"$installLog`" InstallAllUsers=0 TargetDir=`"$PythonRoot`" Include_pip=1 Include_launcher=0 Include_test=0 Include_doc=0 Include_tcltk=0 AssociateFiles=0 Shortcuts=0 PrependPath=0 AppendPath=0"
  $process = Start-Process -FilePath $installerPath -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
  if ($process.ExitCode -notin @(0, 3010)) { throw "Python installer exited with code $($process.ExitCode)" }
  if (Version-Of $privatePython) {
    $python = $privatePython; $pythonSource = "downloaded-private"
  } else {
    $python = Find-CompatiblePython
    $pythonSource = "installer-registered"
  }
}
$pythonVersion = Version-Of $python
if (-not $pythonVersion) {
  throw "Python installer returned success but no runnable Python was found. See $Runtime\python-install.log"
}
Write-Host "Using $pythonVersion ($pythonSource): $python"

$nodeDir = Split-Path -Parent $node
$pythonDir = Split-Path -Parent $python
$env:PATH = "$nodeDir;$pythonDir;$(Join-Path $pythonDir 'Scripts');$NpmPrefix;$env:PATH"
$env:npm_config_prefix = $NpmPrefix
$env:npm_config_cache = Join-Path $Cache "npm"
$env:PIP_CACHE_DIR = Join-Path $Cache "pip"
$env:PIP_DISABLE_PIP_VERSION_CHECK = "1"
$npm = Find-Application @("npm.cmd", "npm.exe", "npm")
if (-not $npm) { throw "npm is unavailable for the selected Node.js runtime" }

if (-not $SkipPythonPackages) {
  Step "Checking Python dependencies"
  New-Item -ItemType Directory -Force -Path $PythonPackages | Out-Null
  $env:PYTHONPATH = if ($env:PYTHONPATH) { "$PythonPackages;$env:PYTHONPATH" } else { $PythonPackages }
  & $python -c "import docx, openpyxl, pptx, requests" 2>$null
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Required Python packages are already available"
  } else {
    & $python -m pip --version 2>$null
    if ($LASTEXITCODE -ne 0) {
      Write-Host "pip is missing; bootstrapping it with ensurepip"
      & $python -m ensurepip --upgrade
      if ($LASTEXITCODE -ne 0) { throw "pip bootstrap failed" }
    }
    & $python -m pip install --target $PythonPackages --requirement (Join-Path $Root "requirements-test.txt")
    if ($LASTEXITCODE -ne 0) { throw "Python dependency installation failed" }
  }
}

Step "Checking Pi and OpenCode"
New-Item -ItemType Directory -Force -Path $NpmPrefix | Out-Null
$privatePi = Join-Path $NpmPrefix "pi.cmd"
$privateOpenCode = Join-Path $NpmPrefix "opencode.cmd"
$pi = if (Version-Of $privatePi) { $privatePi } else { Find-Application @("pi.cmd", "pi.exe", "pi") }
$opencode = if (Version-Of $privateOpenCode) { $privateOpenCode } else { Find-Application @("opencode.cmd", "opencode.exe", "opencode") }
if (-not (Version-Of $pi)) {
  Write-Host "Pi is missing; installing $PiVersion into the project runtime"
  & $npm install --global --ignore-scripts --no-audit --no-fund "@earendil-works/pi-coding-agent@$PiVersion"
  if ($LASTEXITCODE -ne 0) { throw "Pi installation failed" }
  $pi = $privatePi
}
if (-not (Version-Of $opencode)) {
  Write-Host "OpenCode is missing; installing $OpenCodeVersion into the project runtime"
  & $npm install --global --no-audit --no-fund "opencode-ai@$OpenCodeVersion"
  if ($LASTEXITCODE -ne 0) { throw "OpenCode installation failed" }
  $opencode = $privateOpenCode
}
$piVersion = Version-Of $pi
$openCodeVersion = Version-Of $opencode
if (-not $piVersion -or -not $openCodeVersion) { throw "Agent engine validation failed" }

$cmd = @(
  '@echo off',
  ('set "NODE_COMMAND={0}"' -f $node),
  ('set "PYTHON_COMMAND={0}"' -f $python),
  ('set "PI_COMMAND={0}"' -f $pi),
  ('set "OPENCODE_COMMAND={0}"' -f $opencode),
  ('set "PYTHONPATH={0};%PYTHONPATH%"' -f $PythonPackages),
  ('set "PATH={0};{1};{2};{3};%PATH%"' -f $nodeDir, $pythonDir, (Join-Path $pythonDir 'Scripts'), $NpmPrefix),
  'set "PYTHONUTF8=1"'
)
$cmd | Set-Content -LiteralPath (Join-Path $Runtime "runtime-env.cmd") -Encoding ASCII

$envFile = Join-Path $Root ".env"
if (-not (Test-Path $envFile)) {
  Copy-Item -LiteralPath (Join-Path $Root ".env.example") -Destination $envFile
  Write-Host "Created .env from .env.example"
}

[ordered]@{
  node=$nodeVersion; nodeCommand=$node; nodeSource=$nodeSource
  python=$pythonVersion; pythonCommand=$python; pythonSource=$pythonSource
  pi=$piVersion; piCommand=$pi
  opencode=$openCodeVersion; opencodeCommand=$opencode
  preparedAt=(Get-Date).ToUniversalTime().ToString("o")
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Runtime "runtime.json") -Encoding UTF8

Step "Environment is ready"
Write-Host "Node:     $node ($nodeVersion)"
Write-Host "Python:   $python ($pythonVersion)"
Write-Host "Pi:       $pi ($piVersion)"
Write-Host "OpenCode: $opencode ($openCodeVersion)"
Write-Host "Next: edit .env if needed, then run gateway.cmd --engine opencode or gateway.cmd --engine pi"
