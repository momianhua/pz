@echo off
setlocal
set "SETUP_SCRIPT=%~dp0scripts\setup-runtime.ps1"
set "WINDOWS_POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

if not exist "%WINDOWS_POWERSHELL%" (
  echo [ERROR] Windows PowerShell is required to bootstrap the private runtime.
  exit /b 2
)

"%WINDOWS_POWERSHELL%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SETUP_SCRIPT%" %*
exit /b %ERRORLEVEL%
