@echo off
REM trace-mcp-launcher v0.2.0 (Windows)
REM Tiny .cmd shim that invokes the PowerShell launcher. MCP clients spawn
REM this .cmd because they rely on %PATHEXT% resolution which prefers .cmd.
REM Do not edit — re-run `trace-mcp init` to refresh.
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0trace-mcp-launcher.ps1" %*
exit /b %ERRORLEVEL%
