@echo off
setlocal
call "%~dp0scripts\runtime-env.cmd"
if errorlevel 1 exit /b %ERRORLEVEL%
pushd "%PROJECT_ROOT%"
"%NODE_COMMAND%" --env-file-if-exists="%PROJECT_ROOT%\.env" "%PROJECT_ROOT%\src\server.js" %*
set "RESULT=%ERRORLEVEL%"
popd
exit /b %RESULT%
