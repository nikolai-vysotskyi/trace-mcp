# trace-mcp-guard-read.ps1 v0.6.0
# Windows helper for trace-mcp-guard.cmd — implements the Read-handler repeat-read
# dedup logic (per-session allowed read counter with mtime reset).
#
# Called by trace-mcp-guard.cmd on PreToolUse Read events. Writes one decision
# string to stdout:
#
#   ALLOW        - allow the read (caller should exit 0 silently)
#   LIMIT:<n>    - deny: already read <n> times this session (caller emits
#                  the "Already read" deny JSON)
#   DENY_FIRST   - deny: first-time friction cycle (caller emits the generic
#                  "Use trace-mcp" deny JSON; retry will ALLOW)
#
# Inputs are taken from environment variables (simpler than cmd arg quoting):
#   TMG_FILE       - absolute file path being read
#   TMG_SESSION    - session id
#   TMG_ROOT       - project root (pwd of the Claude Code session)
#
# This script is side-effecting: it writes state files under
#   $env:TEMP\trace-mcp-reads-<session>\<file-hash>        ("count:mtime")
# and creates/removes deny markers under
#   $env:TEMP\trace-mcp-guard-<session>\<file-hash>

$ErrorActionPreference = 'SilentlyContinue'

$filePath  = $env:TMG_FILE
$sessionId = $env:TMG_SESSION
$projectRoot = $env:TMG_ROOT
$tmp = $env:TEMP
if (-not $tmp) { $tmp = [System.IO.Path]::GetTempPath().TrimEnd('\','/') }

if (-not $filePath -or -not $sessionId) {
    Write-Output 'ALLOW'
    exit 0
}

$REPEAT_READ_LIMIT = 2

function Sha256Hex([string]$text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
        return [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLower()
    } finally {
        $sha.Dispose()
    }
}

$fileHash = Sha256Hex $filePath

# Read state dir & path
$readsDir = Join-Path $tmp ("trace-mcp-reads-" + $sessionId)
if (-not (Test-Path $readsDir)) {
    New-Item -ItemType Directory -Path $readsDir -Force | Out-Null
}
$readState = Join-Path $readsDir $fileHash

# Current mtime as ticks (cross-version stable)
$curMtime = '0'
if (Test-Path $filePath) {
    try {
        $curMtime = (Get-Item -LiteralPath $filePath).LastWriteTimeUtc.Ticks.ToString()
    } catch {
        $curMtime = '0'
    }
}

# Load previous state
$prevCount = 0
$prevMtime = ''
$hadState = $false
if (Test-Path $readState) {
    $hadState = $true
    $raw = (Get-Content -LiteralPath $readState -Raw).Trim()
    $parts = $raw -split ':', 2
    if ($parts.Length -ge 1) {
        [void][int]::TryParse($parts[0], [ref]$prevCount)
    }
    if ($parts.Length -ge 2) {
        $prevMtime = $parts[1]
    }
}

# Reset count on mtime change (Edit/Write happened).
if ($curMtime -ne $prevMtime) {
    $prevCount = 0
}

# Limit exceeded → deny.
if ($prevCount -ge $REPEAT_READ_LIMIT) {
    Write-Output ("LIMIT:" + $prevCount)
    exit 0
}

# Consultation marker: if trace-mcp already touched this file, allow unconditionally
# (still increments the counter so the limit eventually triggers).
if ($projectRoot) {
    $projectHash = (Sha256Hex $projectRoot).Substring(0, 12)
    $relPath = $filePath
    $rootWithSep = $projectRoot.TrimEnd('\','/') + [System.IO.Path]::DirectorySeparatorChar
    if ($filePath.StartsWith($rootWithSep, [System.StringComparison]::Ordinal)) {
        $relPath = $filePath.Substring($rootWithSep.Length)
    }
    $relPath = $relPath -replace '\\', '/'
    $consultedHash = Sha256Hex $relPath
    $consultedDir = Join-Path $tmp ("trace-mcp-consulted-" + $projectHash)
    $consultedFile = Join-Path $consultedDir $consultedHash
    if (Test-Path $consultedFile) {
        $newCount = $prevCount + 1
        Set-Content -LiteralPath $readState -Value ("{0}:{1}" -f $newCount, $curMtime) -NoNewline
        Write-Output 'ALLOW'
        exit 0
    }
}

# Already tracked this session (even after mtime reset) → skip first-time friction.
if ($hadState) {
    $newCount = $prevCount + 1
    Set-Content -LiteralPath $readState -Value ("{0}:{1}" -f $newCount, $curMtime) -NoNewline
    Write-Output 'ALLOW'
    exit 0
}

# First-time deny-marker cycle: first attempt denies, second attempt (retry) allows.
$denyDir = Join-Path $tmp ("trace-mcp-guard-" + $sessionId)
if (-not (Test-Path $denyDir)) {
    New-Item -ItemType Directory -Path $denyDir -Force | Out-Null
}
$denyMarker = Join-Path $denyDir $fileHash

if (Test-Path $denyMarker) {
    Remove-Item -LiteralPath $denyMarker -Force
    Set-Content -LiteralPath $readState -Value ("1:" + $curMtime) -NoNewline
    Write-Output 'ALLOW'
    exit 0
}

New-Item -ItemType File -Path $denyMarker -Force | Out-Null
Write-Output 'DENY_FIRST'
exit 0
