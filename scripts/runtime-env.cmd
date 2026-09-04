@echo off
for %%I in ("%~dp0..") do set "PROJECT_ROOT=%%~fI"
set "PRIVATE_RUNTIME=%PROJECT_ROOT%\.runtime"
set "PRIVATE_NPM_PREFIX=%PRIVATE_RUNTIME%\npm-global"
set "RUNTIME_ENV_FILE=%PRIVATE_RUNTIME%\runtime-env.cmd"

if not exist "%RUNTIME_ENV_FILE%" (
  echo [ERROR] Prepared runtime configuration is missing. Run setup.cmd first.
  exit /b 2
)
call "%RUNTIME_ENV_FILE%"
if errorlevel 1 exit /b %ERRORLEVEL%
if not exist "%NODE_COMMAND%" (
  echo [ERROR] Configured Node.js is unavailable. Run setup.cmd again.
  exit /b 2
)
set "npm_config_prefix=%PRIVATE_NPM_PREFIX%"
set "npm_config_cache=%PRIVATE_RUNTIME%\cache\npm"
set "PIP_CACHE_DIR=%PRIVATE_RUNTIME%\cache\pip"
exit /b 0
