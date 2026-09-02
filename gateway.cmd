@echo off
node --env-file-if-exists="%~dp0.env" "%~dp0src\server.js" %*
