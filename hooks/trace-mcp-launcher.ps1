# trace-mcp-launcher v0.6.1 (Windows)
# Stable shim backend: resolves node + cli.js at runtime from launcher.env,
# with a probe fallback for nvm-windows/nvs/Volta/system installs.
# Managed by trace-mcp - do not edit by hand. Re-run `trace-mcp init` to refresh.

#Requires -Version 5.1

$ErrorActionPreference = 'Stop'

$TraceHome = if ($env:TRACE_MCP_HOME) { $env:TRACE_MCP_HOME } else { Join-Path $env:USERPROFILE '.trace' }
$ConfigPath = Join-Path $TraceHome 'launcher.env'
$LogPath    = Join-Path $TraceHome 'launcher.log'

# Rotate once per invocation, before the first append (TRA-702). Mirrors
# rotate_log in trace-mcp-launcher.sh. Bounds the log at 2 x the limit across
# both generations; without it the file only ever grew.
$LogMaxBytes = if ($env:TRACE_MCP_LOG_MAX_BYTES) { [int64]$env:TRACE_MCP_LOG_MAX_BYTES } else { 5242880 }
try {
    $existing = Get-Item -LiteralPath $LogPath -ErrorAction SilentlyContinue
    if ($existing -and $existing.Length -gt $LogMaxBytes) {
        Move-Item -LiteralPath $LogPath -Destination "$LogPath.1" -Force -ErrorAction SilentlyContinue
    }
} catch {
    # Never abort on rotation failure.
}

function Write-LauncherLog {
    param([string]$Message)
    try {
        $stamp = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        Add-Content -Path $LogPath -Value "[$stamp] $Message" -ErrorAction SilentlyContinue
    } catch {
        # Never abort on log failure.
    }
}

function Die {
    param([string]$Message)
    Write-LauncherLog "ERROR: $Message"
    [Console]::Error.WriteLine("trace-mcp launcher: $Message")
    [Console]::Error.WriteLine('Recovery: npm i -g trace-mcp && trace-mcp init')
    [Console]::Error.WriteLine('          (or set TRACE_MCP_NODE_OVERRIDE / TRACE_MCP_CLI_OVERRIDE)')
    exit 127
}

# cli.js is built for the `engines.node` range in package.json. An older node
# does not fail loudly - it dies on a SyntaxError the MCP client can only report
# as "failed to connect", which is why the major is checked before we exec.
# Parsed, not cast: a bare [int] cast of an out-of-range value throws under
# $ErrorActionPreference = 'Stop' and would abort the launcher outright.
$NodeMinMajor = 22
if ($env:TRACE_MCP_NODE_MIN_MAJOR) {
    $parsedMin = 0
    if ([int]::TryParse($env:TRACE_MCP_NODE_MIN_MAJOR, [ref]$parsedMin) -and $parsedMin -gt 0) {
        $NodeMinMajor = $parsedMin
    }
}

# A cached major is usable only if it parses into a real integer. Digits alone
# are not enough - an overflowing numeric string would throw on the cast.
function Get-BoundedMajor {
    param([string]$Value)
    $parsed = 0
    if ([int]::TryParse($Value, [ref]$parsed) -and $parsed -ge 0) { return $parsed }
    return $null
}

# --- 1. Parse config safely (no Invoke-Expression, whitelist keys) ---
$NodePath = ''
$CliPath  = ''
$NodeMajor = ''
$UsingOverride = $false
$UsingNodeOverride = $false

# Every file this shim reads is a hint, never a requirement: launcher.env,
# pkg-roots, .npmrc. Under $ErrorActionPreference = 'Stop' a read that throws -
# a file locked by another writer, an I/O error on a mapped drive - escapes the
# whole launcher, so the client gets neither the recovery message nor the probe
# fallback and loses trace-mcp for the session. An unreadable hint must degrade
# to "no hint" (TRA-797).
function Read-LauncherLines {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return @() }
    try { return @([System.IO.File]::ReadAllLines($Path)) } catch { return @() }
}

$configLines = Read-LauncherLines $ConfigPath
if ($configLines.Count -gt 0) {
    foreach ($line in $configLines) {
        $trimmed = $line.TrimStart()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        $idx = $trimmed.IndexOf('=')
        if ($idx -le 0) { continue }
        $key = $trimmed.Substring(0, $idx).Trim()
        $val = $trimmed.Substring($idx + 1).Trim()
        # Strip exactly one pair of surrounding double-quotes if present.
        if ($val.Length -ge 2 -and $val.StartsWith('"') -and $val.EndsWith('"')) {
            $val = $val.Substring(1, $val.Length - 2)
        }
        switch ($key) {
            'TRACE_MCP_NODE' { $NodePath = $val }
            'TRACE_MCP_CLI'  { $CliPath  = $val }
            # Major version of TRACE_MCP_NODE, verified when the pair was
            # recorded. Cached so the fast path never has to run node -v.
            'TRACE_MCP_NODE_MAJOR' { $NodeMajor = $val }
            # TRACE_MCP_VERSION ignored (informational only)
        }
    }
}

# --- 2. Env overrides ---
# $UsingOverride gates persistence (never bake an override into the config);
# $UsingNodeOverride gates the version check, and only the node override may
# waive that.
if ($env:TRACE_MCP_NODE_OVERRIDE) {
    $NodePath = $env:TRACE_MCP_NODE_OVERRIDE
    $UsingOverride = $true
    $UsingNodeOverride = $true
}
if ($env:TRACE_MCP_CLI_OVERRIDE)  { $CliPath  = $env:TRACE_MCP_CLI_OVERRIDE;  $UsingOverride = $true }

function Test-NodeBinary {
    param([string]$Path)
    if (-not $Path) { return $false }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    return $true
}

function Test-CliFile {
    param([string]$Path)
    if (-not $Path) { return $false }
    return (Test-Path -LiteralPath $Path -PathType Leaf)
}

# Persist a probed (or freshly verified) pair so the next start takes the fast path.
function Save-LauncherConfig {
    param([string]$NodeExe, [string]$Cli, [string]$Major = '')
    # The parser strips exactly one pair of quotes and never expands; a literal
    # quote in a path would corrupt the file, so skip rather than mangle.
    if ($NodeExe.Contains('"') -or $Cli.Contains('"')) { return }
    # Never pin the config to a swap-window backup: that directory is about to
    # be deleted, so the "fast path" it buys would be a dangling one.
    if ($Cli -match 'trace-mcp\.tmcp-bak-' -or $Cli -match '[\\/]\.trace-mcp-') { return }
    try {
        if (-not (Test-Path -LiteralPath $TraceHome -PathType Container)) {
            New-Item -ItemType Directory -Path $TraceHome -Force -ErrorAction Stop | Out-Null
        }
        $lines = @(
            '# Managed by trace-mcp - do not edit by hand.',
            '# Rewritten by the launcher after a successful probe.',
            ('TRACE_MCP_NODE="{0}"' -f $NodeExe),
            # TRACE_MCP_VERSION is deliberately dropped: the probed cli.js may be
            # a different build than the one the stale config described, and a
            # wrong version is worse than none. `trace-mcp init` restores it.
            ('TRACE_MCP_CLI="{0}"' -f ($Cli -replace '\\', '/'))
        )
        # Cache the verified major so the fast path stays a pure file check.
        if ($Major -match '^\d+$') { $lines += ('TRACE_MCP_NODE_MAJOR="{0}"' -f $Major) }
        # `.tmp.<pid>.<12 hex>` is the shape sweepOrphanTmpFiles collects
        # (src/utils/atomic-write.ts) - its pattern requires the trailing hex.
        # The catch below only runs for a caught failure; a process killed
        # between the write and the move leaks this file, and without the
        # suffix the sweeper would never match it (TRA-797).
        $tmp = '{0}.tmp.{1}.{2}' -f $ConfigPath, $PID, ((1..12 | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) }) -join '')
        [System.IO.File]::WriteAllLines($tmp, $lines)
        Move-Item -LiteralPath $tmp -Destination $ConfigPath -Force -ErrorAction Stop
    } catch {
        # Best-effort: a failed heal only costs the next start another probe.
        if ($tmp -and (Test-Path -LiteralPath $tmp)) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    }
}

# Major version of a node binary, or $null if it will not run at all.
function Get-NodeMajor {
    param([string]$Path)
    try {
        $out = & $Path -v 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
        if ("$out".Trim() -match '^v?(\d+)\.') { return [int]$Matches[1] }
    } catch {
        return $null
    }
    return $null
}

# --- 3. Fast path: config is good -> exec directly ---
#
# A config recorded before the version gate existed carries no verified major.
# Check it once here, then cache it, so the check costs nothing from the next
# start on - and an already-poisoned config heals itself instead of failing
# forever.
# Only the NODE override exempts a run from the gate. Sharing one flag with
# TRACE_MCP_CLI_OVERRIDE would let a CLI-only debugging override carry the
# configured node past the check - the exact failure this gate exists to stop.
if (-not $UsingNodeOverride -and (Test-NodeBinary $NodePath)) {
    $cached = Get-BoundedMajor $NodeMajor
    if ($null -eq $cached) {
        $probed = Get-NodeMajor $NodePath
        $cached = if ($null -eq $probed) { 0 } else { $probed }
        $NodeMajor = "$cached"
        # Cache only a pair we are actually going to use - never write back a
        # node we are about to reject, and never an override: $CliPath may be a
        # throwaway debug path, and baking it in would outlive the session.
        if (-not $UsingOverride -and $cached -ge $NodeMinMajor -and (Test-CliFile $CliPath)) {
            Save-LauncherConfig $NodePath $CliPath $NodeMajor
        }
    }
    if ($cached -lt $NodeMinMajor) {
        Write-LauncherLog "config node=$NodePath is node $cached, need >= $NodeMinMajor - reprobing"
        $NodePath = ''
    }
}

if ((Test-NodeBinary $NodePath) -and (Test-CliFile $CliPath)) {
    Write-LauncherLog "exec(config) node=$NodePath cli=$CliPath argc=$($args.Count)"
    & $NodePath $CliPath @args
    exit $LASTEXITCODE
}

# --- 4. Probe fallback (stable sources only) ---

function Get-NodeCandidates {
    # Every node.exe we know how to locate, most-preferred first.
    $found = @()

    # 4a. System-wide official installer
    $candidates = @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-NodeBinary $c)) { $found += $c }
    }

    # 4b. Volta (stable shim dir)
    $volta = Join-Path $env:USERPROFILE '.volta\bin\node.exe'
    if (Test-NodeBinary $volta) { $found += $volta }

    # 4c. nvm-windows: $APPDATA\nvm\<ver>\node.exe; active one symlinked via %NVM_SYMLINK%
    if ($env:NVM_SYMLINK) {
        $nvmActive = Join-Path $env:NVM_SYMLINK 'node.exe'
        if (Test-NodeBinary $nvmActive) { $found += $nvmActive }
    }
    $nvmRoot = Join-Path $env:APPDATA 'nvm'
    if (Test-Path -LiteralPath $nvmRoot -PathType Container) {
        $latest = Get-ChildItem -LiteralPath $nvmRoot -Directory -ErrorAction SilentlyContinue |
                  Where-Object { $_.Name -match '^v?\d+\.\d+\.\d+$' } |
                  Sort-Object -Property Name -Descending |
                  Select-Object -First 1
        if ($latest) {
            $candidate = Join-Path $latest.FullName 'node.exe'
            if (Test-NodeBinary $candidate) { $found += $candidate }
        }
    }

    # 4d. nvs: %LOCALAPPDATA%\nvs\default\<arch>\<ver>\node.exe (default alias)
    $nvsDefault = Join-Path $env:LOCALAPPDATA 'nvs\default'
    if (Test-Path -LiteralPath $nvsDefault -PathType Container) {
        $nodeExe = Get-ChildItem -LiteralPath $nvsDefault -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue |
                   Select-Object -First 1
        if ($nodeExe) { $found += $nodeExe.FullName }
    }

    return $found
}

# First candidate new enough to run cli.js. Picking merely the first one that
# exists is what makes a machine whose default node is an old LTS fail forever:
# the exec succeeds, cli.js dies on a SyntaxError, and the pair gets healed into
# launcher.env so every later start repeats it - with no error line anywhere.
function Find-Node {
    # Records whether ANY node.exe was seen, so the failure message can tell
    # "no node installed" apart from "node installed but too old" - including
    # the pkg-roots ones below, which Get-NodeCandidates does not enumerate.
    $script:SawAnyNode = $false
    foreach ($c in @(Get-NodeCandidates)) {
        $script:SawAnyNode = $true
        $major = Get-NodeMajor $c
        if ($null -ne $major -and $major -ge $NodeMinMajor) { return $c }
    }
    # Last resort: node shipped inside a prefix we only know about because our
    # package lives there - a bundled runtime, or a corporate
    # `npm config set prefix`. Get-PkgRoots already enumerates those roots for
    # the cli.js lookup; the node beside one of them is the pair
    # `trace-mcp init` recorded. Without this a machine whose ONLY node is such
    # a runtime dies with "node binary not found" while a working node.exe and
    # cli.js sit on disk.
    foreach ($r in @(Get-PkgRoots $null)) {
        # <prefix>\node_modules and <prefix>\lib\node_modules are both in use.
        foreach ($rel in @('..\node.exe', '..\..\node.exe')) {
            $c = Join-Path $r $rel
            if (-not (Test-NodeBinary $c)) { continue }
            $script:SawAnyNode = $true
            $resolved = (Resolve-Path -LiteralPath $c).Path
            $major = Get-NodeMajor $resolved
            if ($null -ne $major -and $major -ge $NodeMinMajor) { return $resolved }
        }
    }
    return $null
}

# Every global node_modules root worth searching, most-likely-first.
#
# Node and cli.js are resolved INDEPENDENTLY on purpose: any working node can
# run any cli.js. Tying the package lookup to the prefix of the selected node
# killed the server whenever the two lived in different prefixes.
function Get-PkgRoots {
    param([string]$NodeExe)
    $roots = @()
    # npm-global layout on Windows places global modules in %APPDATA%\npm\node_modules\.
    if ($env:APPDATA) { $roots += (Join-Path $env:APPDATA 'npm\node_modules') }
    $nodes = @()
    if ($NodeExe) { $nodes += $NodeExe }
    $nodes += (Get-NodeCandidates)
    foreach ($n in $nodes) {
        if (-not $n) { continue }
        $dir = Split-Path -Parent $n
        $roots += (Join-Path $dir 'node_modules')
        # Unix-style layout (some cross-platform setups)
        $roots += (Join-Path $dir '..\lib\node_modules')
    }
    # Roots recorded by past installs (mirrors src/init/launcher.ts::recordPkgRoot).
    # This is how a prefix we cannot name in advance becomes findable without
    # asking npm at runtime. Values are opaque paths, never evaluated.
    foreach ($line in (Read-LauncherLines (Join-Path $TraceHome 'pkg-roots'))) {
        $t = $line.Trim()
        if ($t -and -not $t.StartsWith('#')) { $roots += $t }
    }
    # Volta keeps each global package under its own image directory.
    if ($env:LOCALAPPDATA) {
        $roots += (Join-Path $env:LOCALAPPDATA 'Volta\tools\image\packages\trace-mcp\lib\node_modules')
    }
    # Custom prefixes (`npm config set prefix`). Read from config files, never
    # by spawning npm: the shim inherits the MCP client's PATH, which in
    # a project directory can contain a repository-controlled `node_modules\.bin`,
    # so spawning a PATH-resolved npm would turn a stale config into code
    # execution from the opened repository.
    $prefix = $env:NPM_CONFIG_PREFIX
    if (-not $prefix -and $env:USERPROFILE) {
        foreach ($line in (Read-LauncherLines (Join-Path $env:USERPROFILE '.npmrc'))) {
            if ($line -match '^\s*prefix\s*=\s*(.+?)\s*$') {
                $prefix = $Matches[1].Trim('"').Trim("'")
            }
        }
    }
    if ($prefix) {
        $roots += (Join-Path $prefix 'node_modules')
        $roots += (Join-Path $prefix 'lib\node_modules')
    }
    return ($roots | Select-Object -Unique)
}

function Find-Cli {
    param([string]$NodeExe)
    $roots = @(Get-PkgRoots $NodeExe)
    foreach ($r in $roots) {
        $c = Join-Path $r 'trace-mcp\dist\cli.js'
        if (Test-Path -LiteralPath $c -PathType Leaf) {
            return (Resolve-Path -LiteralPath $c).Path
        }
    }
    # Last resort: an update is swapping the package right this second. npm and
    # our own updater both rename the live directory aside before unpacking the
    # new one, so a stale-but-working copy is on disk for the length of the
    # window. Serving the previous version beats losing every tool for the rest
    # of the client's session.
    foreach ($r in $roots) {
        if (-not (Test-Path -LiteralPath $r -PathType Container)) { continue }
        $bak = Get-ChildItem -LiteralPath $r -Directory -ErrorAction SilentlyContinue |
               Where-Object { $_.Name -like 'trace-mcp.tmcp-bak-*' -or $_.Name -like '.trace-mcp-*' } |
               ForEach-Object { Join-Path $_.FullName 'dist\cli.js' } |
               Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
               Select-Object -First 1
        if ($bak) { return (Resolve-Path -LiteralPath $bak).Path }
    }
    return $null
}

$Healed = $false

if (-not (Test-NodeBinary $NodePath)) {
    $NodePath = Find-Node
    if (-not $NodePath) {
        if ($script:SawAnyNode) {
            Die "no Node.js >= $NodeMinMajor found - trace-mcp needs it; upgrade Node or set TRACE_MCP_NODE_OVERRIDE"
        }
        Die 'node binary not found - install Node.js (nodejs.org / nvs / nvm-windows / volta) or set TRACE_MCP_NODE_OVERRIDE'
    }
    $probedMajor = Get-NodeMajor $NodePath
    $NodeMajor = if ($null -eq $probedMajor) { '' } else { "$probedMajor" }
    Write-LauncherLog "probe: node=$NodePath (v$NodeMajor)"
    $Healed = $true
}

if (-not (Test-CliFile $CliPath)) {
    $CliPath = Find-Cli $NodePath
    if (-not $CliPath) {
        Die 'trace-mcp package not found in any known npm prefix - run: npm i -g trace-mcp && trace-mcp init'
    }
    Write-LauncherLog "probe: cli=$CliPath"
    $Healed = $true
}

# Overrides are a debugging escape hatch; never bake them into the config.
if ($Healed -and -not $UsingOverride) { Save-LauncherConfig $NodePath $CliPath $NodeMajor }

Write-LauncherLog "exec(probe) node=$NodePath cli=$CliPath argc=$($args.Count)"
& $NodePath $CliPath @args
exit $LASTEXITCODE
