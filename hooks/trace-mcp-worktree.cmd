@echo off
REM trace-mcp-worktree v0.2.0
REM trace-mcp WorktreeCreate / WorktreeRemove hook
REM
REM WorktreeCreate: ensures the *main* repo's index is ready, then exits.
REM   The serve command automatically detects the worktree and shares the
REM   main repo's DB — no separate full re-index needed.
REM
REM WorktreeRemove: no-op. The main repo's DB is unaffected.

setlocal enabledelayedexpansion

set "INPUT="
for /f "delims=" %%i in ('more') do set "INPUT=!INPUT!%%i"

REM Extract event type
for /f "delims=" %%e in ('echo !INPUT! ^| jq -r ".hook_event_name // .event // empty" 2^>nul') do set "EVENT=%%e"
if defined CLAUDE_HOOK_EVENT set "EVENT=%CLAUDE_HOOK_EVENT%"

REM Extract worktree path
for /f "delims=" %%p in ('echo !INPUT! ^| jq -r ".tool_input.path // .worktree_path // .path // .cwd // empty" 2^>nul') do set "WPATH=%%p"

if "%WPATH%"=="" exit /b 0

if "%EVENT%"=="WorktreeCreate" goto :create
if "%EVENT%"=="worktree_create" goto :create
if "%EVENT%"=="create" goto :create
goto :end

:create
  REM Resolve main repo root via git rev-parse --git-common-dir
  set "MAIN_ROOT="
  for /f "delims=" %%g in ('cd /d "%WPATH%" && git rev-parse --git-common-dir 2^>nul') do set "COMMON_GIT=%%g"

  if defined COMMON_GIT (
    REM Make absolute if relative
    if "!COMMON_GIT:~0,1!" NEQ "\" (
      set "COMMON_GIT=%WPATH%\!COMMON_GIT!"
    )
    REM Parent of common .git dir is the main root
    for %%d in ("!COMMON_GIT!\..") do set "MAIN_ROOT=%%~fd"
  )

  if not defined MAIN_ROOT (
    REM Fallback: index the worktree directly
    start /b trace-mcp add "%WPATH%" --force --json >nul 2>&1
    goto :end
  )

  REM Check if main repo already indexed
  set "NEEDS_INDEX=1"
  set "REGISTRY=%USERPROFILE%\.trace-mcp\registry.json"
  if exist "%REGISTRY%" (
    for /f "delims=" %%v in ('jq -r --arg r "!MAIN_ROOT!" ".projects[$r].lastIndexed // empty" "%REGISTRY%" 2^>nul') do (
      if not "%%v"=="" if not "%%v"=="null" set "NEEDS_INDEX=0"
    )
  )

  if "%NEEDS_INDEX%"=="1" (
    start /b trace-mcp add "!MAIN_ROOT!" --json >nul 2>&1
  )
  goto :end

:end
exit /b 0
