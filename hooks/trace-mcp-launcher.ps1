# trace-mcp-launcher v0.5.0 (Windows)
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

# --- 1. Parse config safely (no Invoke-Expression, whitelist keys) ---
$NodePath = ''
$CliPath  = ''
$UsingOverride = $false

if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
    foreach ($line in [System.IO.File]::ReadAllLines($ConfigPath)) {
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
            # TRACE_MCP_VERSION ignored (informational only)
        }
    }
}

# --- 2. Env overrides ---
if ($env:TRACE_MCP_NODE_OVERRIDE) { $NodePath = $env:TRACE_MCP_NODE_OVERRIDE; $UsingOverride = $true }
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

# --- 3. Fast path: config is good -> exec directly ---
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

function Find-Node {
    $candidates = @(Get-NodeCandidates)
    if ($candidates.Count -gt 0) { return $candidates[0] }
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
            if (Test-NodeBinary $c) { return (Resolve-Path -LiteralPath $c).Path }
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
    $rootsFile = Join-Path $TraceHome 'pkg-roots'
    if (Test-Path -LiteralPath $rootsFile -PathType Leaf) {
        foreach ($line in [System.IO.File]::ReadAllLines($rootsFile)) {
            $t = $line.Trim()
            if ($t -and -not $t.StartsWith('#')) { $roots += $t }
        }
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
        $npmrc = Join-Path $env:USERPROFILE '.npmrc'
        if (Test-Path -LiteralPath $npmrc -PathType Leaf) {
            foreach ($line in [System.IO.File]::ReadAllLines($npmrc)) {
                if ($line -match '^\s*prefix\s*=\s*(.+?)\s*$') {
                    $prefix = $Matches[1].Trim('"').Trim("'")
                }
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

# Persist a freshly probed pair so the next start takes the fast path.
function Save-LauncherConfig {
    param([string]$NodeExe, [string]$Cli)
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
        $tmp = "$ConfigPath.tmp.$PID"
        [System.IO.File]::WriteAllLines($tmp, $lines)
        Move-Item -LiteralPath $tmp -Destination $ConfigPath -Force -ErrorAction Stop
    } catch {
        # Best-effort: a failed heal only costs the next start another probe.
        if ($tmp -and (Test-Path -LiteralPath $tmp)) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    }
}

$Healed = $false

if (-not (Test-NodeBinary $NodePath)) {
    $NodePath = Find-Node
    if (-not $NodePath) {
        Die 'node binary not found - install Node.js (nodejs.org / nvs / nvm-windows / volta) or set TRACE_MCP_NODE_OVERRIDE'
    }
    Write-LauncherLog "probe: node=$NodePath"
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
if ($Healed -and -not $UsingOverride) { Save-LauncherConfig $NodePath $CliPath }

Write-LauncherLog "exec(probe) node=$NodePath cli=$CliPath argc=$($args.Count)"
& $NodePath $CliPath @args
exit $LASTEXITCODE
