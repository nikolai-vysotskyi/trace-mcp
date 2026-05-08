# trace-mcp-guard-md-tour.ps1 v0.9.0
# Windows helper for trace-mcp-guard.cmd — implements the .md doc-tour
# detection mirrored from the bash hook (v0.9).
#
# Called by trace-mcp-guard.cmd on PreToolUse Read events for .md files.
# Behavior:
#   - If the file is NOT in a source-tree directory, exit 0 silently
#     (caller treats empty stdout as "allow").
#   - If the file IS in a source-tree directory, increment a per-session
#     counter. When the counter reaches TRACE_MCP_GUARD_MD_HINT_THRESHOLD
#     (default 3), emit a full PreToolUse JSON with additionalContext
#     suggesting get_feature_context / get_task_context. Read still passes —
#     this is a hint, not a block.
#
# Inputs (environment variables):
#   TMG_FILE     - absolute file path being read
#   TMG_SESSION  - session id (per-session state lives under
#                  $env:TEMP\trace-mcp-reads-<session>\)
#   TMG_ROOT     - project root (pwd of the Claude Code session)

$ErrorActionPreference = 'SilentlyContinue'

$filePath = $env:TMG_FILE
$sessionId = $env:TMG_SESSION
if (-not $filePath -or -not $sessionId) { exit 0 }

# Normalize backslashes so the same regexes work as in the bash hook.
$norm = $filePath -replace '\\', '/'

$isMd = $norm -match '(?i)\.md$'
if (-not $isMd) { exit 0 }

$inSource = $norm -match '(?i)/(src|lib|packages|apps?|server|client|pkg|internal|modules|services|pipelines|cmd|tests?|specs?|features?)/'
$excluded = $norm -match '(?i)/(docs?|node_modules|vendor|dist|build|\.git|target|out)/'
if (-not $inSource -or $excluded) { exit 0 }

$tmp = $env:TEMP
if (-not $tmp) { $tmp = [System.IO.Path]::GetTempPath().TrimEnd('\','/') }
$readsDir = Join-Path $tmp ("trace-mcp-reads-" + $sessionId)
if (-not (Test-Path $readsDir)) {
    New-Item -ItemType Directory -Path $readsDir -Force | Out-Null
}
$counterFile = Join-Path $readsDir '.md-tour-count'

$count = 0
if (Test-Path $counterFile) {
    $raw = (Get-Content -LiteralPath $counterFile -Raw).Trim()
    [void][int]::TryParse($raw, [ref]$count)
}
$count = $count + 1
Set-Content -LiteralPath $counterFile -Value "$count" -NoNewline

$threshold = 3
if ($env:TRACE_MCP_GUARD_MD_HINT_THRESHOLD) {
    [void][int]::TryParse($env:TRACE_MCP_GUARD_MD_HINT_THRESHOLD, [ref]$threshold)
}

if ($count -lt $threshold) { exit 0 }

# Compute repo-relative path for the hint message.
$rel = $filePath
$root = $env:TMG_ROOT
if ($root) {
    $rootWithSep = $root.TrimEnd('\','/') + [System.IO.Path]::DirectorySeparatorChar
    if ($filePath.StartsWith($rootWithSep, [System.StringComparison]::Ordinal)) {
        $rel = $filePath.Substring($rootWithSep.Length)
    }
}
$rel = $rel -replace '\\', '/'

$hint = "trace-mcp guard: ${count}x .md reads inside source dirs this session — looks like a doc tour. For per-feature docs co-located with code, get_feature_context / get_task_context is usually faster than reading docs file-by-file. Reading $rel is allowed; this is a hint, not a block.`nAlternatives:`n- get_feature_context { ""description"": ""what these docs describe"" }`n- get_task_context { ""task"": ""what you are working on"" }`n- search { ""query"": ""keyword"", ""file_pattern"": ""**/*.md"" } — find specific doc by name"

$payload = [ordered]@{
    hookSpecificOutput = [ordered]@{
        hookEventName = 'PreToolUse'
        additionalContext = $hint
    }
}
$payload | ConvertTo-Json -Depth 4 -Compress
exit 0
