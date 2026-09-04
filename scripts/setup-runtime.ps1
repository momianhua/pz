[CmdletBinding()]
param(
  [switch]$SkipPythonPackages,
  [switch]$InstallGlobalCommand,
  [string]$PackageDirectory = $env:RUNTIME_PACKAGE_DIR,
  [string]$NodeDownloadBaseUrl = $env:NODE_DOWNLOAD_BASE_URL,
  [string]$PythonDownloadBaseUrl = $env:PYTHON_DOWNLOAD_BASE_URL,
  [string]$NpmRegistry = $env:NPM_CONFIG_REGISTRY,
  [string]$PipIndexUrl = $env:PIP_INDEX_URL,
  [string]$GlobalBinDirectory = $env:GATEWAY_GLOBAL_BIN_DIR
)

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
$NodeDownloadBaseUrl = if ($NodeDownloadBaseUrl) { $NodeDownloadBaseUrl.TrimEnd('/') } else { "https://nodejs.org/dist" }
$PythonDownloadBaseUrl = if ($PythonDownloadBaseUrl) { $PythonDownloadBaseUrl.TrimEnd('/') } else { "https://www.python.org/ftp/python" }

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
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    # npm and other CLIs may emit non-fatal configuration warnings on stderr.
    # Only stdout is version data; suppress stderr so Windows PowerShell 5.1
    # does not turn a harmless warning into a NativeCommandError record.
    $value = & $exe --version 2>$null | Out-String
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($exitCode -ne 0) { return "" }
  return $value.Trim()
}
function Invoke-NativeQuiet([string]$exe, [string[]]$arguments) {
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    & $exe @arguments *> $null
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
}
function Invoke-NativeCapture([string]$exe, [string[]]$arguments) {
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = & $exe @arguments 2>&1 | Out-String
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $output }
  } finally {
    $ErrorActionPreference = $previousPreference
  }
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
    $launcherResult = Invoke-NativeCapture -exe $launcher -arguments @("-0p")
    if ($launcherResult.ExitCode -eq 0) {
      foreach ($match in [regex]::Matches($launcherResult.Output, '[A-Za-z]:\\[^\r\n]*?python\.exe')) {
        [void]$candidates.Add($match.Value.Trim())
      }
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
  $algorithm = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($path)
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $stream.Dispose()
    $algorithm.Dispose()
  }
}
function Acquire-Verified([string]$uri, [string]$target, [string]$hash, [string]$fileName) {
  Assert-RuntimePath $target
  if ((Test-Path -LiteralPath $target) -and (Hash-Of $target) -eq $hash) {
    Write-Host "Using cached $([IO.Path]::GetFileName($target))"
    return
  }
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
  if ($PackageDirectory) {
    $localPackage = Join-Path ([IO.Path]::GetFullPath($PackageDirectory)) $fileName
    if (Test-Path -LiteralPath $localPackage) {
      if ((Hash-Of $localPackage) -ne $hash) { throw "SHA-256 mismatch for local package $localPackage" }
      Write-Host "Using local package $localPackage"
      Copy-Item -LiteralPath $localPackage -Destination $target -Force
    }
  }
  if (-not (Test-Path -LiteralPath $target)) {
    Write-Host "Downloading $uri"
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri $uri -OutFile $target
  }
  if ((Hash-Of $target) -ne $hash) {
    Remove-Item -LiteralPath $target -Force
    throw "SHA-256 mismatch for $uri"
  }
}
function Npm-ForNode([string]$nodeExecutable) {
  if (-not $nodeExecutable) { return "" }
  $directory = Split-Path -Parent $nodeExecutable
  foreach ($name in @("npm.cmd", "npm.exe")) {
    $candidate = Join-Path $directory $name
    if (Version-Of $candidate) { return $candidate }
  }
  return ""
}
function Has-ExactVersion([string]$executable, [string]$expected) {
  $parsed = Parsed-Version (Version-Of $executable)
  return $parsed -and $parsed -eq [version]$expected
}
function Escape-CmdValue([string]$value) { return $value.Replace('%', '%%') }
function Install-GatewayCommand([string]$binDirectory, [bool]$persistUserPath) {
  if (-not $binDirectory) {
    $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    if (-not $localAppData) { throw "Cannot resolve the current user's LocalApplicationData directory" }
    $binDirectory = Join-Path $localAppData "pz-gateway\bin"
  }
  $binDirectory = [IO.Path]::GetFullPath($binDirectory)
  $commandPath = Join-Path $binDirectory "gateway.cmd"
  $scriptPath = Join-Path $binDirectory "gateway.ps1"
  $marker = "pz-agent-gateway managed launcher"

  if ($persistUserPath) {
    $projectCommand = [IO.Path]::GetFullPath((Join-Path $Root "gateway.cmd"))
    $existingCommands = @(Get-Command gateway.cmd, gateway.exe, gateway -CommandType Application -All -ErrorAction SilentlyContinue)
    foreach ($existing in $existingCommands) {
      $existingPath = [IO.Path]::GetFullPath($existing.Source)
      if ($existingPath -ne $commandPath -and $existingPath -ne $projectCommand) {
        throw "A different global gateway command already exists at $existingPath. Refusing to shadow it."
      }
    }
  }

  foreach ($managedPath in @($commandPath, $scriptPath)) {
    if (-not (Test-Path -LiteralPath $managedPath)) { continue }
    $existingContent = Get-Content -LiteralPath $managedPath -Raw
    if ($existingContent -notmatch [regex]::Escape($marker)) {
      throw "Refusing to overwrite unmanaged command file: $managedPath"
    }
  }

  New-Item -ItemType Directory -Force -Path $binDirectory | Out-Null
  $projectLauncher = [IO.Path]::GetFullPath((Join-Path $Root "gateway.cmd"))
  if (-not (Test-Path -LiteralPath $projectLauncher)) { throw "Project launcher is missing: $projectLauncher" }
  $escapedProjectLauncher = $projectLauncher.Replace("'", "''")
  $powerShellLines = @(
    "# $marker",
    "`$projectLauncher = '$escapedProjectLauncher'",
    'if (-not (Test-Path -LiteralPath $projectLauncher)) { Write-Error "Registered gateway project no longer exists: $projectLauncher. Rerun setup.cmd -InstallGlobalCommand from the new project location."; exit 2 }',
    "& `$projectLauncher @args",
    "exit `$LASTEXITCODE"
  )
  $cmdLines = @(
    '@echo off',
    "rem $marker",
    '"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0gateway.ps1" %*',
    'exit /b %ERRORLEVEL%'
  )
  $scriptTemp = "$scriptPath.tmp"
  $commandTemp = "$commandPath.tmp"
  $powerShellLines | Set-Content -LiteralPath $scriptTemp -Encoding UTF8
  $cmdLines | Set-Content -LiteralPath $commandTemp -Encoding ASCII
  Move-Item -LiteralPath $scriptTemp -Destination $scriptPath -Force
  Move-Item -LiteralPath $commandTemp -Destination $commandPath -Force

  if ($persistUserPath) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $pathEntries = @($userPath -split ';' | Where-Object { $_ } | ForEach-Object { $_.Trim().TrimEnd('\') })
    $normalizedBin = $binDirectory.TrimEnd('\')
    if (-not ($pathEntries | Where-Object { $_.Equals($normalizedBin, [StringComparison]::OrdinalIgnoreCase) })) {
      [Environment]::SetEnvironmentVariable("Path", ((@($pathEntries) + $binDirectory) -join ';'), "User")
      Write-Host "Added $binDirectory to the user PATH"
    } else {
      Write-Host "User PATH already contains $binDirectory"
    }
  }
  Write-Host "Global gateway command installed: $commandPath"
  return $commandPath
}

# Setup execution starts here. Functions above this marker are exercised independently by tests.
if (-not [Environment]::Is64BitOperatingSystem) { throw "Only 64-bit Windows 10/11 is supported." }
foreach ($requiredFile in @("requirements-test.txt", ".env.example", "package.json")) {
  if (-not (Test-Path -LiteralPath (Join-Path $Root $requiredFile))) { throw "Required project file is missing: $requiredFile" }
}
New-Item -ItemType Directory -Force -Path $Runtime, $Downloads, $Cache | Out-Null

Step "Detecting Node.js"
$privateNode = Join-Path $NodeRoot "node.exe"
$node = ""
$npm = ""
$nodeSource = ""
$privateNpm = Npm-ForNode $privateNode
if ((Parsed-Version (Version-Of $privateNode)) -ge [version]"22.19.0" -and $privateNpm) {
  $node = $privateNode; $npm = $privateNpm; $nodeSource = "project-private"
} else {
  $candidate = Find-Application @("node.exe", "node")
  $candidateNpm = Npm-ForNode $candidate
  if ((Parsed-Version (Version-Of $candidate)) -ge [version]"22.19.0" -and $candidateNpm) {
    $node = $candidate; $npm = $candidateNpm; $nodeSource = "system"
  }
}
if (-not $node) {
  Write-Host "Compatible Node.js is missing; installing private v$NodeVersion"
  $archiveName = "node-v$NodeVersion-win-x64.zip"
  $archive = Join-Path $Downloads $archiveName
  Acquire-Verified "$NodeDownloadBaseUrl/v$NodeVersion/$archiveName" $archive $NodeHash $archiveName
  $extract = Join-Path $Runtime "node-extract"
  Assert-RuntimePath $extract
  Assert-RuntimePath $NodeRoot
  if (Test-Path $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
  if (Test-Path $NodeRoot) { Remove-Item -LiteralPath $NodeRoot -Recurse -Force }
  Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force
  $expandedNode = Join-Path $extract "node-v$NodeVersion-win-x64"
  foreach ($requiredPath in @("node.exe", "npm.cmd", "node_modules\npm\bin\npm-cli.js")) {
    if (-not (Test-Path -LiteralPath (Join-Path $expandedNode $requiredPath))) {
      throw "Node archive has an unexpected layout; missing $requiredPath"
    }
  }
  New-Item -ItemType Directory -Force -Path $NodeRoot | Out-Null
  Copy-Item (Join-Path $expandedNode "*") $NodeRoot -Recurse -Force
  Remove-Item -LiteralPath $extract -Recurse -Force
  $node = $privateNode; $npm = Npm-ForNode $privateNode; $nodeSource = "downloaded-private"
}
$nodeVersion = Version-Of $node
if (-not $nodeVersion -or -not $npm) { throw "Node.js/npm runtime validation failed" }
Write-Host "Using $nodeVersion ($nodeSource): $node"
Write-Host "Using npm $(Version-Of $npm): $npm"

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
  Acquire-Verified "$PythonDownloadBaseUrl/$PythonVersion/$installerName" $installerPath $PythonHash $installerName
  if (Get-Command Get-AuthenticodeSignature -ErrorAction SilentlyContinue) {
    $signature = Get-AuthenticodeSignature -LiteralPath $installerPath
    $signer = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { "" }
    if ($signature.Status -in @("HashMismatch", "NotSigned") -or ($signer -and $signer -notmatch "Python Software Foundation")) {
      throw "Python installer signature validation failed: status=$($signature.Status), signer=$signer"
    }
    if ($signature.Status -ne "Valid") {
      Write-Warning "Python signature trust status is $($signature.Status); continuing because the pinned SHA-256 matched."
    }
  } else {
    Write-Warning "Authenticode verification is unavailable; continuing because the pinned SHA-256 matched."
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
if ($NpmRegistry) { $env:NPM_CONFIG_REGISTRY = $NpmRegistry }
if ($PipIndexUrl) { $env:PIP_INDEX_URL = $PipIndexUrl }

if (-not $SkipPythonPackages) {
  Step "Checking Python dependencies"
  New-Item -ItemType Directory -Force -Path $PythonPackages | Out-Null
  $env:PYTHONPATH = if ($env:PYTHONPATH) { "$PythonPackages;$env:PYTHONPATH" } else { $PythonPackages }
  $dependencyCheck = "from importlib.metadata import version; expected={'python-docx':'1.2.0','openpyxl':'3.1.5','python-pptx':'1.0.2','requests':'2.32.5'}; raise SystemExit(0 if all(version(k)==v for k,v in expected.items()) else 1)"
  $importExitCode = Invoke-NativeQuiet -exe $python -arguments @("-c", $dependencyCheck)
  if ($importExitCode -eq 0) {
    Write-Host "Required Python packages are already available"
  } else {
    $pipExitCode = Invoke-NativeQuiet -exe $python -arguments @("-m", "pip", "--version")
    if ($pipExitCode -ne 0) {
      Write-Host "pip is missing; bootstrapping it with ensurepip"
      & $python -m ensurepip --upgrade
      if ($LASTEXITCODE -ne 0) { throw "pip bootstrap failed" }
    }
    & $python -m pip install --upgrade --target $PythonPackages --requirement (Join-Path $Root "requirements-test.txt")
    if ($LASTEXITCODE -ne 0) { throw "Python dependency installation failed" }
  }
}

Step "Checking Pi and OpenCode"
New-Item -ItemType Directory -Force -Path $NpmPrefix | Out-Null
$privatePi = Join-Path $NpmPrefix "pi.cmd"
$privateOpenCode = Join-Path $NpmPrefix "opencode.cmd"
$systemPi = Find-Application @("pi.cmd", "pi.exe", "pi")
$systemOpenCode = Find-Application @("opencode.cmd", "opencode.exe", "opencode")
$pi = if (Has-ExactVersion $privatePi $PiVersion) { $privatePi } elseif (Has-ExactVersion $systemPi $PiVersion) { $systemPi } else { "" }
$opencode = if (Has-ExactVersion $privateOpenCode $OpenCodeVersion) { $privateOpenCode } elseif (Has-ExactVersion $systemOpenCode $OpenCodeVersion) { $systemOpenCode } else { "" }
if (-not $pi) {
  Write-Host "Pi is missing; installing $PiVersion into the project runtime"
  & $npm install --global --ignore-scripts --no-audit --no-fund "@earendil-works/pi-coding-agent@$PiVersion"
  if ($LASTEXITCODE -ne 0) { throw "Pi installation failed" }
  $pi = $privatePi
}
if (-not $opencode) {
  Write-Host "OpenCode is missing; installing $OpenCodeVersion into the project runtime"
  & $npm install --global --no-audit --no-fund "opencode-ai@$OpenCodeVersion"
  if ($LASTEXITCODE -ne 0) { throw "OpenCode installation failed" }
  $opencode = $privateOpenCode
}
$piVersion = Version-Of $pi
$openCodeVersion = Version-Of $opencode
if (-not (Has-ExactVersion $pi $PiVersion) -or -not (Has-ExactVersion $opencode $OpenCodeVersion)) {
  throw "Agent engine version validation failed; expected Pi $PiVersion and OpenCode $OpenCodeVersion"
}

$cmd = @(
  '@echo off',
  ('set "NODE_COMMAND={0}"' -f (Escape-CmdValue $node)),
  ('set "PYTHON_COMMAND={0}"' -f (Escape-CmdValue $python)),
  ('set "PI_COMMAND={0}"' -f (Escape-CmdValue $pi)),
  ('set "OPENCODE_COMMAND={0}"' -f (Escape-CmdValue $opencode)),
  ('set "PYTHONPATH={0};%PYTHONPATH%"' -f (Escape-CmdValue $PythonPackages)),
  ('set "PATH={0};{1};{2};{3};%PATH%"' -f (Escape-CmdValue $nodeDir), (Escape-CmdValue $pythonDir), (Escape-CmdValue (Join-Path $pythonDir 'Scripts')), (Escape-CmdValue $NpmPrefix)),
  'set "PYTHONUTF8=1"'
)
$environmentFile = Join-Path $Runtime "runtime-env.cmd"
$environmentTemp = Join-Path $Runtime "runtime-env.cmd.tmp"
$cmd | Set-Content -LiteralPath $environmentTemp -Encoding ASCII
Move-Item -LiteralPath $environmentTemp -Destination $environmentFile -Force

$envFile = Join-Path $Root ".env"
if (Test-Path -LiteralPath $envFile) {
  Write-Host "Keeping existing .env unchanged"
} else {
  Write-Warning ".env does not exist. Create it from .env.example and configure the model before real-mode startup."
}

$manifest = [ordered]@{
  node=$nodeVersion; nodeCommand=$node; nodeSource=$nodeSource
  python=$pythonVersion; pythonCommand=$python; pythonSource=$pythonSource
  pi=$piVersion; piCommand=$pi
  opencode=$openCodeVersion; opencodeCommand=$opencode
  preparedAt=(Get-Date).ToUniversalTime().ToString("o")
}
$manifestTemp = Join-Path $Runtime "runtime.json.tmp"
$manifest | ConvertTo-Json | Set-Content -LiteralPath $manifestTemp -Encoding UTF8
Move-Item -LiteralPath $manifestTemp -Destination (Join-Path $Runtime "runtime.json") -Force

if ($InstallGlobalCommand) {
  Step "Installing global gateway command"
  [void](Install-GatewayCommand -binDirectory $GlobalBinDirectory -persistUserPath $true)
  Write-Host "Open a new terminal, then run: gateway --engine opencode"
}

Step "Environment is ready"
Write-Host "Node:     $node ($nodeVersion)"
Write-Host "Python:   $python ($pythonVersion)"
Write-Host "Pi:       $pi ($piVersion)"
Write-Host "OpenCode: $opencode ($openCodeVersion)"
Write-Host "Next: edit .env if needed, then run gateway.cmd --engine opencode or gateway.cmd --engine pi"
