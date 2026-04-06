@echo off
REM trace-mcp-worktree v0.1.0
REM trace-mcp WorktreeCreate / WorktreeRemove hook
REM On WorktreeCreate: registers and indexes the new worktree.
REM On WorktreeRemove: deregisters the worktree project.

setlocal enabledelayedexpansion

set "INPUT="
for /f "delims=" %%i in ('more') do set "INPUT=!INPUT!%%i"

REM Extract event type
for /f "delims=" %%e in ('echo !INPUT! ^| jq -r ".hook_event_name // .event // empty" 2^>nul') do set "EVENT=%%e"
if not defined CLAUDE_HOOK_EVENT set "CLAUDE_HOOK_EVENT=%EVENT%"
if defined CLAUDE_HOOK_EVENT set "EVENT=%CLAUDE_HOOK_EVENT%"

REM Extract worktree path
for /f "delims=" %%p in ('echo !INPUT! ^| jq -r ".tool_input.path // .worktree_path // .path // .cwd // empty" 2^>nul') do set "WPATH=%%p"

if "%WPATH%"=="" exit /b 0

if "%EVENT%"=="WorktreeCreate" (
  start /b trace-mcp add "%WPATH%" --force --json >nul 2>&1
) else if "%EVENT%"=="WorktreeRemove" (
  REM Clean up worktree DB file if it exists
  for /f "delims=" %%h in ('echo %WPATH%^| certutil -hashfile - SHA256 2^>nul ^| findstr /v "hash"') do set "PHASH=%%h"
  if defined PHASH (
    set "PHASH=!PHASH:~0,12!"
    del /q "%USERPROFILE%\.trace-mcp\db\!PHASH!.db" "%USERPROFILE%\.trace-mcp\db\!PHASH!.db-shm" "%USERPROFILE%\.trace-mcp\db\!PHASH!.db-wal" 2>nul
  )
)

exit /b 0
