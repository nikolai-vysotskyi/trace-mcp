@echo off
REM trace-mcp-guard v0.2.0
REM trace-mcp PreToolUse guard (Windows)
REM Blocks Read/Grep/Glob/Bash on source code files - redirects to trace-mcp tools.
REM Allows: non-code files, Read before Edit, safe Bash commands (git, npm, build, test).
REM
REM Install: add to ~\.claude\settings.json or .claude\settings.local.json
REM See README.md for setup instructions.

setlocal enabledelayedexpansion

REM Read JSON from stdin into a temp file
set "TMPINPUT=%TEMP%\trace-mcp-guard-input-%RANDOM%.json"
more > "%TMPINPUT%"

REM Get tool name from env or parse from JSON
if defined CLAUDE_TOOL_NAME (
    set "TOOL_NAME=%CLAUDE_TOOL_NAME%"
) else (
    for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content '%TMPINPUT%' -Raw | ConvertFrom-Json).tool_name"`) do set "TOOL_NAME=%%i"
)

if "%TOOL_NAME%"=="" goto :allow

REM --- Read ---
if /i not "%TOOL_NAME%"=="Read" goto :check_grep

for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content '%TMPINPUT%' -Raw | ConvertFrom-Json).tool_input.file_path"`) do set "FILE_PATH=%%i"

REM Block .env files
echo "%FILE_PATH%" | findstr /i /r "\.env" >nul 2>&1
if %errorlevel%==0 (
    set "REL_PATH=%FILE_PATH%"
    call :deny "Use get_env_vars for .env files - it masks sensitive values (passwords, API keys, tokens)." "trace-mcp alternatives: get_env_vars to list keys + types without exposing secrets."
    goto :cleanup
)

REM Allow non-code files
echo "%FILE_PATH%" | findstr /i /r "\.md$ \.json$ \.jsonc$ \.yaml$ \.yml$ \.toml$ \.ini$ \.cfg$ \.txt$ \.html$ \.xml$ \.csv$ \.svg$ \.lock$ \.log$ \.sh$ \.bash$ \.zsh$ \.fish$ \.ps1$ \.bat$ \.cmd$" >nul 2>&1
if %errorlevel%==0 goto :allow

REM Allow files in non-source dirs
echo "%FILE_PATH%" | findstr /i /r "node_modules\\ vendor\\ dist\\ build\\ \.git\\" >nul 2>&1
if %errorlevel%==0 goto :allow

REM Block code file reads - redirect to trace-mcp
echo "%FILE_PATH%" | findstr /i /r "\.ts$ \.tsx$ \.js$ \.jsx$ \.mjs$ \.cjs$ \.py$ \.pyi$ \.go$ \.rs$ \.java$ \.kt$ \.kts$ \.rb$ \.php$ \.cs$ \.cpp$ \.c$ \.h$ \.hpp$ \.swift$ \.scala$ \.vue$ \.svelte$ \.astro$" >nul 2>&1
if not %errorlevel%==0 goto :allow

REM Allow on second attempt (agent needs full content for Edit)
set "SESSION_ID=default"
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "try { (Get-Content '%TMPINPUT%' -Raw | ConvertFrom-Json).session_id } catch { 'default' }"`) do set "SESSION_ID=%%i"
set "DENY_DIR=%TEMP%\trace-mcp-guard-%SESSION_ID%"
if not exist "%DENY_DIR%" mkdir "%DENY_DIR%" 2>nul

REM Create a hash of the file path for the marker
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "[System.BitConverter]::ToString([System.Security.Cryptography.MD5]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes('%FILE_PATH%'))).Replace('-','')"`) do set "MARKER_HASH=%%i"
set "DENY_MARKER=%DENY_DIR%\%MARKER_HASH%"

if exist "%DENY_MARKER%" (
    del "%DENY_MARKER%" 2>nul
    goto :allow
)
echo.> "%DENY_MARKER%"

call :deny "Use trace-mcp for code reading - it returns only what you need, saving tokens." "trace-mcp alternatives: get_outline, get_symbol, search, get_feature_context. If you need full file content before editing, retry Read - it will be allowed."
goto :cleanup

:check_grep
REM --- Grep ---
if /i not "%TOOL_NAME%"=="Grep" goto :check_glob

for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content '%TMPINPUT%' -Raw | ConvertFrom-Json).tool_input.path"`) do set "GREP_PATH=%%i"
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content '%TMPINPUT%' -Raw | ConvertFrom-Json).tool_input.glob"`) do set "GREP_GLOB=%%i"
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content '%TMPINPUT%' -Raw | ConvertFrom-Json).tool_input.type"`) do set "GREP_TYPE=%%i"

REM Block grep on .env files
echo "%GREP_GLOB%" | findstr /i /r "\.env" >nul 2>&1
if %errorlevel%==0 (
    call :deny "Use get_env_vars for .env files - it masks sensitive values." "trace-mcp alternatives: get_env_vars with pattern filter."
    goto :cleanup
)
echo "%GREP_PATH%" | findstr /i /r "\.env" >nul 2>&1
if %errorlevel%==0 (
    call :deny "Use get_env_vars for .env files - it masks sensitive values." "trace-mcp alternatives: get_env_vars with pattern filter."
    goto :cleanup
)

REM Allow grep on non-code file types
echo "%GREP_GLOB%" | findstr /i /r "\.md \.json \.ya*ml \.toml \.txt \.html \.xml \.csv \.cfg \.ini \.lock \.log" >nul 2>&1
if %errorlevel%==0 goto :allow

REM Allow grep on non-code type filter
if /i "%GREP_TYPE%"=="md" goto :allow
if /i "%GREP_TYPE%"=="json" goto :allow
if /i "%GREP_TYPE%"=="yaml" goto :allow
if /i "%GREP_TYPE%"=="toml" goto :allow
if /i "%GREP_TYPE%"=="xml" goto :allow
if /i "%GREP_TYPE%"=="html" goto :allow
if /i "%GREP_TYPE%"=="csv" goto :allow

REM Allow grep on config dirs
echo "%GREP_PATH%" | findstr /i /r "node_modules vendor dist build \.git" >nul 2>&1
if %errorlevel%==0 goto :allow

for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content '%TMPINPUT%' -Raw | ConvertFrom-Json).tool_input.pattern"`) do set "PATTERN=%%i"
call :deny "Use trace-mcp for code search - it understands symbols and relationships." "trace-mcp alternatives: search, find_usages, get_call_graph. Use Grep only for non-code files (.md, .json, .yaml, config)."
goto :cleanup

:check_glob
REM --- Glob ---
if /i not "%TOOL_NAME%"=="Glob" goto :check_bash

for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content '%TMPINPUT%' -Raw | ConvertFrom-Json).tool_input.pattern"`) do set "GLOB_PATTERN=%%i"

REM Block glob on .env patterns
echo "%GLOB_PATTERN%" | findstr /i /r "\.env" >nul 2>&1
if %errorlevel%==0 (
    call :deny "Use get_env_vars for .env files - it masks sensitive values." "trace-mcp alternatives: get_env_vars to list all env vars across all .env files."
    goto :cleanup
)

REM Allow glob for non-code patterns
echo "%GLOB_PATTERN%" | findstr /i /r "\.md \.json \.ya*ml \.toml \.txt \.html \.xml \.csv \.cfg \.ini \.lock \.log" >nul 2>&1
if %errorlevel%==0 goto :allow

call :deny "Use trace-mcp for code file discovery - it knows your project structure." "trace-mcp alternatives: get_project_map, search with file_pattern, get_outline. Use Glob only for non-code file patterns."
goto :cleanup

:check_bash
REM --- Bash ---
if /i not "%TOOL_NAME%"=="Bash" goto :allow

for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content '%TMPINPUT%' -Raw | ConvertFrom-Json).tool_input.command"`) do set "COMMAND=%%i"

REM Allow safe commands
echo "%COMMAND%" | findstr /i /r /c:"^git " /c:"^npm " /c:"^npx " /c:"^pnpm " /c:"^yarn " /c:"^bun " /c:"^node " /c:"^deno " /c:"^cargo " /c:"^go " /c:"^make " /c:"^mvn " /c:"^gradle " /c:"^docker " /c:"^kubectl " /c:"^helm " /c:"^terraform " /c:"^pip " /c:"^poetry " /c:"^uv " /c:"^pytest " /c:"^vitest " /c:"^jest " /c:"^phpunit " /c:"^composer " /c:"^artisan " /c:"^rails " /c:"^bundle " /c:"^mix " /c:"^dotnet " /c:"^cmake " >nul 2>&1
if %errorlevel%==0 goto :allow

REM Block code exploration via bash
set "HAS_EXPLORE=0"
echo "%COMMAND%" | findstr /i /r "grep rg find cat head tail less more awk sed" >nul 2>&1
if %errorlevel%==0 set "HAS_EXPLORE=1"

set "HAS_CODE=0"
echo "%COMMAND%" | findstr /i /r "\.ts \.tsx \.js \.jsx \.py \.go \.rs \.java \.rb \.php \.cs \.cpp \.c \.h \.swift \.scala \.vue \.svelte" >nul 2>&1
if %errorlevel%==0 set "HAS_CODE=1"

if "%HAS_EXPLORE%"=="1" if "%HAS_CODE%"=="1" (
    call :deny "Use trace-mcp instead of shell commands for code exploration." "trace-mcp has structured tools: search, get_symbol, get_outline, find_usages. Use Bash only for builds, tests, git, and system commands."
    goto :cleanup
)

goto :allow

REM --- Helpers ---

:deny
set "REASON=%~1"
set "CONTEXT=%~2"
echo {
echo   "hookSpecificOutput": {
echo     "hookEventName": "PreToolUse",
echo     "permissionDecision": "deny",
echo     "permissionDecisionReason": "%REASON%",
echo     "additionalContext": "%CONTEXT%"
echo   }
echo }
goto :eof

:allow
del "%TMPINPUT%" 2>nul
exit /b 0

:cleanup
del "%TMPINPUT%" 2>nul
exit /b 0
