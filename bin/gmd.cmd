@echo off
rem gmd —— Windows 转发壳（PLAN §0.3：命令名必须是 gmd）
rem 不装 PATH 也能用：node --experimental-strip-types src\cli.ts ...
setlocal
set "HERE=%~dp0"
node --experimental-strip-types "%HERE%..\src\cli.ts" %*
exit /b %ERRORLEVEL%
