@echo off
REM trace-mcp-guard v0.15.0
REM trace-mcp PreToolUse guard (Windows)
REM Blocks Read/Grep/Glob/Bash on source code files + Agent(Explore) subagents - redirects to trace-mcp tools.
REM Allows: non-code files, Read before Edit, safe Bash commands (git, npm, build, test).
REM
REM Enforcement tier (TRACE_MCP_ENFORCE):
REM   advisory (default): warn but allow native tool calls.
REM   strict:             hard-deny calls that trace-mcp can already serve.
REM   off:                silent, always allow.
REM   unknown/typo:       falls back to advisory.
REM
REM Consultation markers: trace-mcp server writes markers when tools access files.
REM If a marker exists, Read is allowed immediately.
REM
REM Repeat-read dedup (v0.6.0): tracks per-session allowed reads of each code file.
REM After 2 allowed reads of an unchanged file, subsequent reads are denied with a
REM redirect to get_symbol/get_outline. Edits (mtime change) reset the counter.
REM
REM Install: add to ~\.claude\settings.json or .claude\settings.local.json
REM See README.md for setup instructions.

setlocal enabledelayedexpansion

REM ─── Enforcement tier ───────────────────────────────────────────────
REM Read TRACE_MCP_ENFORCE; default advisory; unknown value → advisory.
set "ENFORCE_TIER=advisory"
if defined TRACE_MCP_ENFORCE (
    if /i "%TRACE_MCP_ENFORCE%"=="strict"   set "ENFORCE_TIER=strict"
    if /i "%TRACE_MCP_ENFORCE%"=="advisory" set "ENFORCE_TIER=advisory"
    if /i "%TRACE_MCP_ENFORCE%"=="off"      set "ENFORCE_TIER=off"
)
if /i "%ENFORCE_TIER%"=="off" goto :allow

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

REM Extract session id once — needed by .md doc-tour helper and the code-file branch.
set "SESSION_ID=default"
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "try { (Get-Content '%TMPINPUT%' -Raw | ConvertFrom-Json).session_id } catch { 'default' }"`) do set "SESSION_ID=%%i"

REM --- Read ---
if /i not "%TOOL_NAME%"=="Read" goto :check_grep

for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content '%TMPINPUT%' -Raw | ConvertFrom-Json).tool_input.file_path"`) do set "FILE_PATH=%%i"

REM Targeted pre-Edit reads (offset or limit present) — always allow even under strict.
REM Read-before-Edit is a mandatory workflow step; blocking it breaks safe code edits.
set "READ_OFFSET="
set "READ_LIMIT="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "try { $v=(Get-Content '%TMPINPUT%' -Raw | ConvertFrom-Json).tool_input.offset; if ($null -ne $v) { $v } else { '' } } catch { '' }"`) do set "READ_OFFSET=%%i"
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "try { $v=(Get-Content '%TMPINPUT%' -Raw | ConvertFrom-Json).tool_input.limit; if ($null -ne $v) { $v } else { '' } } catch { '' }"`) do set "READ_LIMIT=%%i"
if defined READ_OFFSET goto :allow
if defined READ_LIMIT  goto :allow

REM Block .env files (example/template variants are exempt - placeholders only)
call :is_env_example "%FILE_PATH%"
if "%ENV_EXAMPLE%"=="0" (
    echo "%FILE_PATH%" | findstr /i /r "\.env" >nul 2>&1
    if !errorlevel!==0 (
        set "REL_PATH=%FILE_PATH%"
        call :deny "Use get_env_vars for .env files - it masks sensitive values (passwords, API keys, tokens)." "trace-mcp alternatives: get_env_vars to list keys + types without exposing secrets. Template files like .env.example/.env.sample are allowed."
        goto :cleanup
    )
)

REM Allow non-code, non-.md files (json, yaml, etc.) unconditionally.
echo "%FILE_PATH%" | findstr /i /r "\.json$ \.jsonc$ \.yaml$ \.yml$ \.toml$ \.ini$ \.cfg$ \.txt$ \.html$ \.xml$ \.csv$ \.svg$ \.lock$ \.log$ \.sh$ \.bash$ \.zsh$ \.fish$ \.ps1$ \.bat$ \.cmd$" >nul 2>&1
if %errorlevel%==0 goto :allow

REM .md special-case: allow, but watch for "Second Brain" doc-tour patterns
REM (per-feature .md docs co-located with code under src/, packages/, etc.).
REM The helper either exits silently (clean allow) or writes a full
REM PreToolUse JSON with additionalContext (hint, still allowed).
echo "%FILE_PATH%" | findstr /i /r "\.md$" >nul 2>&1
if %errorlevel%==0 (
    set "TMG_FILE=%FILE_PATH%"
    set "TMG_SESSION=%SESSION_ID%"
    set "TMG_ROOT=%CD%"
    if exist "%~dp0trace-mcp-guard-md-tour.ps1" (
        powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0trace-mcp-guard-md-tour.ps1"
    )
    goto :cleanup
)

REM Allow files in non-source dirs
echo "%FILE_PATH%" | findstr /i /r "node_modules\\ vendor\\ dist\\ build\\ \.git\\" >nul 2>&1
if %errorlevel%==0 goto :allow

REM Block code file reads - redirect to trace-mcp
echo "%FILE_PATH%" | findstr /i /r "\.ts$ \.tsx$ \.js$ \.jsx$ \.mjs$ \.cjs$ \.py$ \.pyi$ \.go$ \.rs$ \.java$ \.kt$ \.kts$ \.rb$ \.php$ \.cs$ \.cpp$ \.c$ \.h$ \.hpp$ \.swift$ \.scala$ \.vue$ \.svelte$ \.astro$" >nul 2>&1
if not %errorlevel%==0 goto :allow

REM Delegate repeat-read dedup + consultation marker + deny-marker cycle to PowerShell helper.
REM The helper lives next to this .cmd and is installed by trace-mcp init/upgrade.
set "TMG_SCRIPT=%~dp0trace-mcp-guard-read.ps1"
if not exist "%TMG_SCRIPT%" goto :legacy_read_path

set "TMG_FILE=%FILE_PATH%"
set "TMG_SESSION=%SESSION_ID%"
set "TMG_ROOT=%CD%"
set "TMG_OFFSET=%READ_OFFSET%"
set "TMG_LIMIT=%READ_LIMIT%"

set "DECISION="
for /f "usebackq delims=" %%d in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%TMG_SCRIPT%"`) do set "DECISION=%%d"

if "%DECISION%"=="ALLOW" goto :allow

if /i "%DECISION:~0,6%"=="LIMIT:" (
    set "PREV_COUNT=%DECISION:~6%"
    call :deny "Already read %FILE_PATH% !PREV_COUNT!x this session - use get_symbol/get_outline instead of re-reading." "trace-mcp alternatives: get_symbol, get_outline, get_context_bundle, get_feature_context. Counter resets automatically on Edit/Write."
    goto :cleanup
)

if /i "%DECISION%"=="DENY_FIRST" (
    call :nav_hit
    if "!NAV_BELOW!"=="1" goto :allow
    call :deny "Use trace-mcp for code reading - it returns only what you need, saving tokens." "trace-mcp alternatives: get_outline, get_symbol, search, get_feature_context. If you need full file content before editing, retry Read - it will be allowed."
    goto :cleanup
)

REM Unknown / empty decision → fall through to legacy path.

:legacy_read_path
REM Fallback: if the PowerShell helper is missing (corrupted install), use the
REM pre-v0.6.0 logic (consultation marker + deny-marker cycle, no dedup).
for /f "usebackq delims=" %%h in (`powershell -NoProfile -Command "[System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes('%CD%'))).Replace('-','').Substring(0,12).ToLower()"`) do set "PROJ_HASH=%%h"
set "REL_FOR_HASH=%FILE_PATH%"
set "REL_FOR_HASH=!REL_FOR_HASH:%CD%\=!"
set "REL_FOR_HASH=!REL_FOR_HASH:\=/!"
for /f "usebackq delims=" %%h in (`powershell -NoProfile -Command "[System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes('!REL_FOR_HASH!'))).Replace('-','').ToLower()"`) do set "FILE_HASH=%%h"
REM Markers live under the state home; %TEMP% is the pre-TRA-869 location and is
REM still checked because the server writes both while old hooks exist.
set "TRACE_STATE_HOME=%TRACE_MCP_DATA_DIR%"
if "!TRACE_STATE_HOME!"=="" set "TRACE_STATE_HOME=%USERPROFILE%\.trace"
if exist "!TRACE_STATE_HOME!\status\trace-mcp-consulted-!PROJ_HASH!\!FILE_HASH!" goto :allow
if exist "%TEMP%\trace-mcp-consulted-!PROJ_HASH!\!FILE_HASH!" goto :allow

set "DENY_DIR=%TEMP%\trace-mcp-guard-%SESSION_ID%"
if not exist "%DENY_DIR%" mkdir "%DENY_DIR%" 2>nul
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "[System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes('%FILE_PATH%'))).Replace('-','').ToLower()"`) do set "MARKER_HASH=%%i"
set "DENY_MARKER=%DENY_DIR%\%MARKER_HASH%"

if exist "%DENY_MARKER%" (
    del "%DENY_MARKER%" 2>nul
    goto :allow
)
echo.> "%DENY_MARKER%"

call :nav_hit
if "!NAV_BELOW!"=="1" goto :allow
call :deny "Use trace-mcp for code reading - it returns only what you need, saving tokens." "trace-mcp alternatives: get_outline, get_symbol, search, get_feature_context. If you need full file content before editing, retry Read - it will be allowed."
goto :cleanup

:check_grep
REM --- Grep ---
if /i not "%TOOL_NAME%"=="Grep" goto :check_glob

for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content '%TMPINPUT%' -Raw | ConvertFrom-Json).tool_input.path"`) do set "GREP_PATH=%%i"
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content '%TMPINPUT%' -Raw | ConvertFrom-Json).tool_input.glob"`) do set "GREP_GLOB=%%i"
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content '%TMPINPUT%' -Raw | ConvertFrom-Json).tool_input.type"`) do set "GREP_TYPE=%%i"

REM Block grep on .env files (example/template variants are exempt)
call :is_env_example "%GREP_GLOB%"
set "GLOB_IS_EXAMPLE=%ENV_EXAMPLE%"
if "%GLOB_IS_EXAMPLE%"=="0" (
    echo "%GREP_GLOB%" | findstr /i /r "\.env" >nul 2>&1
    if !errorlevel!==0 (
        call :deny "Use get_env_vars for .env files - it masks sensitive values." "trace-mcp alternatives: get_env_vars with pattern filter. Template files like .env.example/.env.sample are allowed."
        goto :cleanup
    )
)
call :is_env_example "%GREP_PATH%"
if "%ENV_EXAMPLE%"=="0" (
    echo "%GREP_PATH%" | findstr /i /r "\.env" >nul 2>&1
    if !errorlevel!==0 (
        call :deny "Use get_env_vars for .env files - it masks sensitive values." "trace-mcp alternatives: get_env_vars with pattern filter. Template files like .env.example/.env.sample are allowed."
        goto :cleanup
    )
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
call :nav_hit
if "!NAV_BELOW!"=="1" goto :allow
call :deny "Use trace-mcp for code search - it understands symbols and relationships." "trace-mcp alternatives: search, find_usages, get_call_graph. Use Grep only for non-code files (.md, .json, .yaml, config)."
goto :cleanup

:check_glob
REM --- Glob ---
if /i not "%TOOL_NAME%"=="Glob" goto :check_bash

for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content '%TMPINPUT%' -Raw | ConvertFrom-Json).tool_input.pattern"`) do set "GLOB_PATTERN=%%i"

REM Block glob on .env patterns (example/template variants are exempt)
call :is_env_example "%GLOB_PATTERN%"
if "%ENV_EXAMPLE%"=="0" (
    echo "%GLOB_PATTERN%" | findstr /i /r "\.env" >nul 2>&1
    if !errorlevel!==0 (
        call :deny "Use get_env_vars for .env files - it masks sensitive values." "trace-mcp alternatives: get_env_vars to list all env vars across all .env files. Template files like .env.example/.env.sample are allowed."
        goto :cleanup
    )
)

REM Allow glob for non-code patterns
echo "%GLOB_PATTERN%" | findstr /i /r "\.md \.json \.ya*ml \.toml \.txt \.html \.xml \.csv \.cfg \.ini \.lock \.log" >nul 2>&1
if %errorlevel%==0 goto :allow

call :nav_hit
if "!NAV_BELOW!"=="1" goto :allow
call :deny "Use trace-mcp for code file discovery - it knows your project structure." "trace-mcp alternatives: get_project_map, search with file_pattern, get_outline. Use Glob only for non-code file patterns."
goto :cleanup

:check_agent
REM --- Agent ---
REM Block Agent(Explore) and exploration-style Agent(general-purpose).
REM Each Agent subprocess costs ~50K tokens overhead (system prompt + CLAUDE.md + memory).
if /i not "%TOOL_NAME%"=="Agent" goto :check_bash

for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "try { (Get-Content '%TMPINPUT%' -Raw | ConvertFrom-Json).tool_input.subagent_type } catch { 'general-purpose' }"`) do set "SUBAGENT_TYPE=%%i"
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content '%TMPINPUT%' -Raw | ConvertFrom-Json).tool_input.description"`) do set "DESCRIPTION=%%i"

REM Always block Explore agents
if /i "%SUBAGENT_TYPE%"=="Explore" (
    call :deny "Agent(Explore) wastes ~50K tokens on overhead. Use trace-mcp tools instead (~4K tokens)." "trace-mcp alternatives: get_task_context, get_feature_context, batch with multiple search/get_outline/get_symbol calls, get_project_map."
    goto :cleanup
)

REM Block general-purpose agents doing code exploration
if /i "%SUBAGENT_TYPE%"=="general-purpose" (
    echo "%DESCRIPTION%" | findstr /i /r "explore investigate understand analyz analys audit review study inspect catalog trace walkthrough summarize summarise identify discover locate document how.*work where.*defined where.*used list.*files list.*symbols list.*classes map.*depend map.*import find.*usage find.*reference find.*caller find.*definition" >nul 2>&1
    if !errorlevel!==0 (
        call :deny "Agent(general-purpose) for code exploration wastes ~50K tokens. Use trace-mcp tools instead." "trace-mcp alternatives: get_task_context, get_feature_context, find_usages, get_call_graph, batch. Agent is OK for: writing code, running tests, web research, Plan mode."
        goto :cleanup
    )
)

goto :allow

:check_bash
REM --- Bash ---
if /i not "%TOOL_NAME%"=="Bash" goto :allow

for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-Content '%TMPINPUT%' -Raw | ConvertFrom-Json).tool_input.command"`) do set "COMMAND=%%i"

REM Allow safe commands
echo "%COMMAND%" | findstr /i /r /c:"^git " /c:"^npm " /c:"^npx " /c:"^pnpm " /c:"^yarn " /c:"^bun " /c:"^node " /c:"^deno " /c:"^cargo " /c:"^go " /c:"^make " /c:"^mvn " /c:"^gradle " /c:"^docker " /c:"^kubectl " /c:"^helm " /c:"^terraform " /c:"^pip " /c:"^poetry " /c:"^uv " /c:"^pytest " /c:"^vitest " /c:"^jest " /c:"^phpunit " /c:"^composer " /c:"^artisan " /c:"^rails " /c:"^bundle " /c:"^mix " /c:"^dotnet " /c:"^cmake " >nul 2>&1
if %errorlevel%==0 goto :allow

REM Block bash commands targeting .env files - prevent secret leakage.
REM Example/template variants are exempt (placeholders only).
call :is_env_example "%COMMAND%"
if "%ENV_EXAMPLE%"=="0" (
    echo "%COMMAND%" | findstr /i /r "\.env" >nul 2>&1
    if !errorlevel!==0 (
        call :deny "Use get_env_vars for .env files - it masks sensitive values (passwords, API keys, tokens)." "trace-mcp alternatives: get_env_vars to list keys + types without exposing secrets. Never access .env files via shell. Template files like .env.example/.env.sample are allowed."
        goto :cleanup
    )
)

REM Block ls/dir/find on source-tree paths (code exploration disguised as listing).
REM Allows: plain `ls`/`dir`, `ls .`, `ls /tmp/...`, `dir C:\Temp`, `ls dist/`.
REM Denies: `ls src/...`, `dir packages\foo`, `find src -type f`, etc.
set "HAS_LIST=0"
echo "%COMMAND%" | findstr /i /r /c:"^ls " /c:"^dir " /c:"^find " /c:" ls " /c:" dir " /c:" find " /c:"&&ls " /c:"&&dir " /c:"&&find " /c:";ls " /c:";dir " /c:";find " /c:"|ls " /c:"|dir " /c:"|find " >nul 2>&1
if %errorlevel%==0 set "HAS_LIST=1"

set "HAS_SRC=0"
echo "%COMMAND%" | findstr /i /r /c:" src[/\\]" /c:" lib[/\\]" /c:" packages[/\\]" /c:" apps[/\\]" /c:" app[/\\]" /c:" server[/\\]" /c:" client[/\\]" /c:" pkg[/\\]" /c:" internal[/\\]" /c:" modules[/\\]" /c:" services[/\\]" /c:" pipelines[/\\]" /c:" cmd[/\\]" /c:"[/\\]src[/\\]" /c:"[/\\]lib[/\\]" /c:"[/\\]packages[/\\]" /c:"[/\\]apps[/\\]" /c:"[/\\]app[/\\]" /c:"[/\\]server[/\\]" /c:"[/\\]client[/\\]" /c:"[/\\]pkg[/\\]" /c:"[/\\]internal[/\\]" /c:"[/\\]modules[/\\]" /c:"[/\\]services[/\\]" /c:"[/\\]pipelines[/\\]" /c:"[/\\]cmd[/\\]" >nul 2>&1
if %errorlevel%==0 set "HAS_SRC=1"

set "HAS_VENDORED=0"
echo "%COMMAND%" | findstr /i /r /c:"node_modules" /c:"vendor[/\\]" /c:"dist[/\\]" /c:"build[/\\]" /c:"\.git[/\\]" /c:"target[/\\]" /c:" out[/\\]" >nul 2>&1
if %errorlevel%==0 set "HAS_VENDORED=1"

if "%HAS_LIST%"=="1" if "%HAS_SRC%"=="1" if "%HAS_VENDORED%"=="0" (
    call :nav_hit
    if "!NAV_BELOW!"=="1" goto :allow
    call :deny "Use trace-mcp instead of ls/dir/find on source-tree paths - it knows your project structure." "trace-mcp alternatives: get_project_map (structure overview), get_outline (file symbols), search with file_pattern. Use ls/dir/find only on non-source dirs (dist, build, /tmp, node_modules)."
    goto :cleanup
)

REM Block code exploration via bash
set "HAS_EXPLORE=0"
echo "%COMMAND%" | findstr /i /r "grep rg find cat head tail less more awk sed" >nul 2>&1
if %errorlevel%==0 set "HAS_EXPLORE=1"

set "HAS_CODE=0"
echo "%COMMAND%" | findstr /i /r "\.ts \.tsx \.js \.jsx \.py \.go \.rs \.java \.rb \.php \.cs \.cpp \.c \.h \.swift \.scala \.vue \.svelte" >nul 2>&1
if %errorlevel%==0 set "HAS_CODE=1"

if "%HAS_EXPLORE%"=="1" if "%HAS_CODE%"=="1" (
    call :nav_hit
    if "!NAV_BELOW!"=="1" goto :allow
    call :deny "Use trace-mcp instead of shell commands for code exploration." "trace-mcp has structured tools: search, get_symbol, get_outline, find_usages. Use Bash only for builds, tests, git, and system commands."
    goto :cleanup
)

goto :allow

REM --- Helpers ---

REM Navigation streak gate (guard v2 - TRA-711).
REM TRA-705 measured the trace path at 1.45x the cost of a bare grep agent on a
REM single light navigation question at equal correctness, so the guard stays
REM silent until the session is actually crawling. Sets NAV_BELOW=1 while the
REM session is still under the threshold; callers allow the call when it is.
REM
REM Full parity with the POSIX gate in trace-mcp-guard.sh (TRA-757): the
REM relationship-question bypass and the rolling window are both honoured here.
REM Windows does ship a UserPromptSubmit hook (trace-mcp-user-prompt-submit.cmd)
REM and it clears .nav-streak on every new prompt, so a count that only ever
REM grew would have made the guard intervene on every navigation call for the
REM rest of the session - exactly the light-question regression the gate exists
REM to remove. State file format is shared with the POSIX hook: "count epoch".
:nav_hit
set "NAV_BELOW=0"
set "NAV_MIN=3"
if defined TRACE_MCP_GUARD_NAV_MIN set "NAV_MIN=%TRACE_MCP_GUARD_NAV_MIN%"
set /a NAV_MIN=NAV_MIN+0 >nul 2>&1
if !NAV_MIN! LEQ 1 goto :eof
set "NAV_DIR=%TEMP%\trace-mcp-reads-%SESSION_ID%"
if not exist "!NAV_DIR!" mkdir "!NAV_DIR!" >nul 2>&1
REM Relationship question in flight - intervene from the first call.
if exist "!NAV_DIR!\.nav-force" goto :eof
set "NAV_WINDOW=300"
if defined TRACE_MCP_GUARD_NAV_WINDOW set "NAV_WINDOW=%TRACE_MCP_GUARD_NAV_WINDOW%"
set /a NAV_WINDOW=NAV_WINDOW+0 >nul 2>&1
set "NAV_COUNT=0"
set "NAV_LAST=0"
if exist "!NAV_DIR!\.nav-streak" (
    for /f "usebackq tokens=1,2" %%a in ("!NAV_DIR!\.nav-streak") do (
        set "NAV_COUNT=%%a"
        set "NAV_LAST=%%b"
    )
)
set /a NAV_COUNT=NAV_COUNT+0 >nul 2>&1
set /a NAV_LAST=NAV_LAST+0 >nul 2>&1
set "NAV_NOW=0"
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()"`) do set "NAV_NOW=%%i"
set /a NAV_NOW=NAV_NOW+0 >nul 2>&1
if !NAV_LAST! EQU 0 (
    set "NAV_COUNT=0"
) else (
    set /a NAV_GAP=NAV_NOW-NAV_LAST
    if !NAV_GAP! GTR !NAV_WINDOW! set "NAV_COUNT=0"
)
set /a NAV_COUNT=NAV_COUNT+1 >nul 2>&1
> "!NAV_DIR!\.nav-streak" echo !NAV_COUNT! !NAV_NOW!
if !NAV_COUNT! LSS !NAV_MIN! set "NAV_BELOW=1"
goto :eof

:is_env_example
REM Sets ENV_EXAMPLE=1 if %1 contains a template-style env filename
REM (.env.example, .env.sample, .env.template, .env.dist, .env.defaults, .env.docs).
REM These are committed to git with placeholders and must not be blocked.
set "ENV_EXAMPLE=0"
echo %~1| findstr /i /c:".env.example" /c:".env.examples" /c:".env.sample" /c:".env.samples" /c:".env.template" /c:".env.templates" /c:".env.dist" /c:".env.defaults" /c:".env.default" /c:".env.docs" /c:".env.doc" >nul 2>&1
if not errorlevel 1 set "ENV_EXAMPLE=1"
goto :eof

:deny
set "REASON=%~1"
set "CONTEXT=%~2"
REM advisory tier: allow but surface the hint via additionalContext.
REM strict tier: hard-deny via permissionDecision:deny.
if /i "%ENFORCE_TIER%"=="advisory" (
    echo {
    echo   "hookSpecificOutput": {
    echo     "hookEventName": "PreToolUse",
    echo     "additionalContext": "[trace-mcp guard] %REASON% %CONTEXT%"
    echo   }
    echo }
    goto :eof
)
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
