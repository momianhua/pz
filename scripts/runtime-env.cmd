@echo off
for %%I in ("%~dp0..") do set "PROJECT_ROOT=%%~fI"
set "PRIVATE_RUNTIME=%PROJECT_ROOT%\.runtime"
set "PRIVATE_NODE=%PRIVATE_RUNTIME%\node"
set "PRIVATE_PYTHON=%PRIVATE_RUNTIME%\python"
set "PRIVATE_NPM_PREFIX=%PRIVATE_RUNTIME%\npm-global"

if not exist "%PRIVATE_NODE%\node.exe" (
  echo [ERROR] Private Node runtime is missing. Run setup.cmd first.
  exit /b 2
)
if not exist "%PRIVATE_PYTHON%\python.exe" (
  echo [ERROR] Private Python runtime is missing. Run setup.cmd first.
  exit /b 2
)
if not exist "%PRIVATE_NPM_PREFIX%\pi.cmd" (
  echo [ERROR] Private Pi installation is missing. Run setup.cmd first.
  exit /b 2
)
if not exist "%PRIVATE_NPM_PREFIX%\opencode.cmd" (
  echo [ERROR] Private OpenCode installation is missing. Run setup.cmd first.
  exit /b 2
)

set "PATH=%PRIVATE_NODE%;%PRIVATE_PYTHON%;%PRIVATE_PYTHON%\Scripts;%PRIVATE_NPM_PREFIX%;%PATH%"
set "NODE_COMMAND=%PRIVATE_NODE%\node.exe"
if not defined PYTHON_COMMAND set "PYTHON_COMMAND=%PRIVATE_PYTHON%\python.exe"
if not defined PI_COMMAND set "PI_COMMAND=%PRIVATE_NPM_PREFIX%\pi.cmd"
if not defined OPENCODE_COMMAND set "OPENCODE_COMMAND=%PRIVATE_NPM_PREFIX%\opencode.cmd"
set "PYTHONUTF8=1"
set "npm_config_prefix=%PRIVATE_NPM_PREFIX%"
set "npm_config_cache=%PRIVATE_RUNTIME%\cache\npm"
set "PIP_CACHE_DIR=%PRIVATE_RUNTIME%\cache\pip"
exit /b 0
