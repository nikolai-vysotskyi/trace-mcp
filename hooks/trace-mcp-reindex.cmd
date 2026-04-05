@echo off
REM trace-mcp-reindex v0.1.0
REM trace-mcp PostToolUse auto-reindex hook (Windows)
REM Triggers incremental reindex after Edit/Write/MultiEdit on code files.
REM Runs trace-mcp index-file in the background - non-blocking.
REM
REM Install: add to ~\.claude\settings.json or .claude\settings.local.json under PostToolUse
REM See README.md for setup instructions.

setlocal enabledelayedexpansion

REM Read JSON from stdin into a temp file
set "TMPINPUT=%TEMP%\trace-mcp-reindex-input-%RANDOM%.json"
more > "%TMPINPUT%"

REM Get tool name from env or parse from JSON
if defined CLAUDE_TOOL_NAME (
    set "TOOL_NAME=%CLAUDE_TOOL_NAME%"
) else (
    for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content '%TMPINPUT%' -Raw | ConvertFrom-Json).tool_name"`) do set "TOOL_NAME=%%i"
)

REM Only handle edit-like tools
if /i not "%TOOL_NAME%"=="Edit" if /i not "%TOOL_NAME%"=="Write" if /i not "%TOOL_NAME%"=="MultiEdit" goto :done

for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content '%TMPINPUT%' -Raw | ConvertFrom-Json).tool_input.file_path"`) do set "FILE_PATH=%%i"

if "%FILE_PATH%"=="" goto :done

REM Skip non-code files
echo "%FILE_PATH%" | findstr /i /r "\.md$ \.json$ \.jsonc$ \.yaml$ \.yml$ \.toml$ \.ini$ \.cfg$ \.env \.txt$ \.html$ \.xml$ \.csv$ \.svg$ \.lock$ \.log$ \.sh$ \.bash$ \.zsh$ \.fish$ \.ps1$ \.bat$ \.cmd$" >nul 2>&1
if %errorlevel%==0 goto :done

REM Skip if not a recognised code file
echo "%FILE_PATH%" | findstr /i /r "\.ts$ \.tsx$ \.js$ \.jsx$ \.mjs$ \.cjs$ \.py$ \.pyi$ \.go$ \.rs$ \.java$ \.kt$ \.kts$ \.rb$ \.php$ \.cs$ \.cpp$ \.c$ \.h$ \.hpp$ \.swift$ \.scala$ \.vue$ \.svelte$ \.astro$" >nul 2>&1
if not %errorlevel%==0 goto :done

REM Reindex in background - non-blocking, silent
start /b "" cmd /c "trace-mcp index-file "%FILE_PATH%" >nul 2>&1"

:done
del "%TMPINPUT%" 2>nul
exit /b 0
