@echo off
REM trace-mcp-launcher v0.4.0 (Windows)
REM Tiny .cmd shim that invokes the PowerShell launcher. MCP clients spawn
REM this .cmd because they rely on %PATHEXT% resolution which prefers .cmd.
REM -WindowStyle Hidden keeps the cmd->powershell hop windowless: windowsHide
REM on the parent spawn() is not inherited across this hop, so without the
REM flag a console flashes visibly for a moment on first daemon start.
REM Do not edit — re-run `trace-mcp init` to refresh.
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0trace-mcp-launcher.ps1" %*
exit /b %ERRORLEVEL%
