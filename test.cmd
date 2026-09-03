@echo off
setlocal
call "%~dp0scripts\runtime-env.cmd"
if errorlevel 1 exit /b %ERRORLEVEL%
pushd "%PROJECT_ROOT%"
"%NODE_COMMAND%" --test
set "RESULT=%ERRORLEVEL%"
popd
exit /b %RESULT%
