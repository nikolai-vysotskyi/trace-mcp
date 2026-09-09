# trace-mcp-launcher v0.6.16 (Windows)
# Stable shim backend: resolves node + cli.js at runtime from launcher.env,
# with a probe fallback for nvm-windows/nvs/Volta/system installs.
# Managed by trace-mcp - do not edit by hand. Re-run `trace-mcp init` to refresh.

#Requires -Version 5.1

$ErrorActionPreference = 'Stop'

# Determine $TraceHome:
# 1. Explicit TRACE_MCP_HOME or TRACE_MCP_DATA_DIR override.
# 2. Sibling directory of this shim: installed at <TraceHome>\bin\trace.cmd
#    and trace-mcp-launcher.ps1. If launcher.env or .config.json exists in
#    the parent directory, use it. This survives modified USERPROFILE or isolated homes.
# 3. $USERPROFILE\.trace
# 4. $USERPROFILE\.trace-mcp (legacy)
$TraceHome = ''
if ($env:TRACE_MCP_HOME) {
    $TraceHome = $env:TRACE_MCP_HOME
} elseif ($env:TRACE_MCP_DATA_DIR) {
    $TraceHome = $env:TRACE_MCP_DATA_DIR
} else {
    if ($PSScriptRoot) {
        $candidate = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
        if ((Test-Path -LiteralPath (Join-Path $candidate 'launcher.env') -PathType Leaf) -or (Test-Path -LiteralPath (Join-Path $candidate '.config.json') -PathType Leaf)) {
            $TraceHome = $candidate
        }
    }
    if (-not $TraceHome -and $env:USERPROFILE) {
        $defaultTrace = Join-Path $env:USERPROFILE '.trace'
        if ((Test-Path -LiteralPath $defaultTrace -PathType Container) -or -not (Test-Path -LiteralPath (Join-Path $env:USERPROFILE '.trace-mcp') -PathType Container)) {
            $TraceHome = $defaultTrace
        } else {
            $TraceHome = Join-Path $env:USERPROFILE '.trace-mcp'
        }
    }
}
if (-not $TraceHome) { $TraceHome = Join-Path $env:USERPROFILE '.trace' }

$env:TRACE_MCP_HOME = $TraceHome
$env:TRACE_MCP_DATA_DIR = $TraceHome

$ConfigPath = Join-Path $TraceHome 'launcher.env'
$LogPath    = Join-Path $TraceHome 'launcher.log'

# Rotate once per invocation, before the first append (TRA-702). Mirrors
# rotate_log in trace-mcp-launcher.sh. Bounds the log at 2 x the limit across
# both generations; without it the file only ever grew.
$LogMaxBytes = 5242880
try {
    # Inside the try on purpose: $ErrorActionPreference is 'Stop', so a
    # non-numeric override would throw on the cast and abort the whole shim
    # before it ever execs node - a logging knob must never cost a start.
    if ($env:TRACE_MCP_LOG_MAX_BYTES) { $LogMaxBytes = [int64]$env:TRACE_MCP_LOG_MAX_BYTES }
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

# --- 1. Parse config safely (no Invoke-Expression, whitelist keys) ---
$NodePath = ''
$CliPath  = ''
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
            # TRACE_MCP_NODE_MAJOR and TRACE_MCP_VERSION ignored
            # (informational only; older configs may still carry them)
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

# $true unless $Path is one of our own `node-runtime.cmd` shims whose target is
# gone.
#
# The desktop app records `bin\node-runtime.cmd` as TRACE_MCP_NODE - a .cmd
# that runs the app binary with ELECTRON_RUN_AS_NODE
# (packages/app/src/main/daemon-install.ts). Test-NodeBinary is true for that
# .cmd long after the app it points at has been replaced by an update,
# moved or uninstalled, so the fast path runs it, cmd fails to start the
# target, and the MCP client loses all ~170 tools for the rest of the session -
# with no ERROR line, because from the .cmd's own side nothing went wrong
# (TRA-965).
#
# Two gates, in this order, and both matter:
#
#  1. The basename. RUNTIME_SHIM_NAME in daemon-install.ts is always
#     `node-runtime.cmd`, so anything else - every real node.exe - is answered
#     without opening the file at all.
#  2. The marker, matched anywhere in the header rather than on a fixed line:
#     the shim has gained comment lines before and may again, and a
#     line-number match would silently stop recognising it.
#
# Once the marker says this IS our shim, an unreadable or unparseable body is
# a failure, not a pass: returning "fine" there restores the exact outage this
# closes the moment the generator's invocation line changes shape. Reprobing
# costs a probe; running an unverified shim costs the session.
function Test-RuntimeShim {
    param([string]$Path)
    if ([System.IO.Path]::GetFileName($Path) -ne 'node-runtime.cmd') { return $true }
    try {
        $head = Get-Content -LiteralPath $Path -TotalCount 8 -ErrorAction Stop
    } catch {
        return $false
    }
    if (-not ($head | Where-Object { $_ -match '^rem Managed by the trace-mcp app' })) { return $true }
    $target = $null
    foreach ($line in $head) {
        if ($line -match '^"(.+)" %\*\s*$') { $target = $Matches[1] }
    }
    if (-not $target) { return $false }
    return (Test-Path -LiteralPath $target -PathType Leaf)
}

function Test-AppRuntime {
    param([string]$Path)
    if (-not $Path) { return $false }
    if ($Path -like '*\Contents\MacOS\*' -or $Path -like '*\trace-mcp.app\*') { return $true }
    if ([System.IO.Path]::GetFileName($Path) -eq 'node-runtime.cmd') {
        try {
            $head = Get-Content -LiteralPath $Path -TotalCount 8 -ErrorAction Stop
            if ($head | Where-Object { $_ -match '^rem Managed by the trace-mcp app' }) { return $true }
        } catch { return $false }
    }
    return $false
}

# `Length -gt 0`, not merely "the file is there" (TRA-1132). Test-NodeBinary
# above closed "exists but does not run" for node; this is the same class on
# the other half of the pair. A zero-byte dist/cli.js - what a disk-full write,
# an unclean shutdown or a half-restored backup leaves behind - is a valid
# empty program to node: exit 0, no output, no stderr. The client sees a server
# that starts, says nothing and leaves; the shim logs no ERROR because its own
# launch worked; and the pair is already in launcher.env, so every later start
# repeats it.
function Test-CliFile {
    param([string]$Path)
    if (-not $Path) { return $false }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $item = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
    return ($null -ne $item -and $item.Length -gt 0)
}

# Persist a probed (or freshly verified) pair so the next start takes the fast path.
function Save-LauncherConfig {
    param([string]$NodeExe, [string]$Cli)
    # The parser strips exactly one pair of quotes and never expands; a literal
    # quote in a path would corrupt the file, so skip rather than mangle.
    if ($NodeExe.Contains('"') -or $Cli.Contains('"')) { return }
    # Never pin the config to a swap-window backup: that directory is about to
    # be deleted, so the "fast path" it buys would be a dangling one.
    if ($Cli -match 'trace-mcp\.tmcp-bak-' -or $Cli -match '[\\/]\.trace-mcp-') { return }
    # A directory at the config path cannot be replaced by a move: Move-Item
    # drops the tmp INSIDE it instead, so the heal never lands and every later
    # start leaves another orphan there that nothing collects (TRA-829).
    if (Test-Path -LiteralPath $ConfigPath -PathType Container) {
        Write-LauncherLog ("ERROR: {0} is not a regular file - cannot persist the probed pair; remove it and run: trace-mcp init" -f $ConfigPath)
        return
    }
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

# --- TRA-970: daemon-aware fast path ---
#
# When a trace-mcp daemon is already listening, exec the thin proxy bundle
# (dist/proxy.js, sibling of cli.js) instead of cli.js itself: it skips
# loading Commander, PluginRegistry, better-sqlite3 and tree-sitter into this
# process entirely, rather than loading all of it and only then discovering a
# daemon exists - cli.js pays that cost just by being started, no matter which
# subcommand runs.
function Test-DaemonPortOpen {
    $port = 3741
    if ($env:TRACE_MCP_DAEMON_PORT) {
        $parsedPort = 0
        if ([int]::TryParse($env:TRACE_MCP_DAEMON_PORT, [ref]$parsedPort) -and $parsedPort -gt 0) {
            $port = $parsedPort
        }
    }
    try {
        $client = [System.Net.Sockets.TcpClient]::new()
        $asyncResult = $client.BeginConnect('127.0.0.1', $port, $null, $null)
        $success = $asyncResult.AsyncWaitHandle.WaitOne(100, $false)
        if ($success -and $client.Connected) {
            $client.EndConnect($asyncResult)
            $client.Close()
            return $true
        }
        $client.Close()
        return $false
    } catch {
        return $false
    }
}

# True when argv is a plain `serve` invocation this shim understands well
# enough to route to the thin proxy: no args, `serve`, `serve --preset X`,
# `--preset X`, or `--preset=X`.
function Test-PlainServe {
    param([string[]]$CommandArgs)
    if (-not $CommandArgs -or $CommandArgs.Count -eq 0) { return $true }
    if ($CommandArgs.Count -eq 1) {
        if ($CommandArgs[0] -eq 'serve') { return $true }
        if ($CommandArgs[0].StartsWith('--preset=') -and $CommandArgs[0].Length -gt 9) { return $true }
        return $false
    }
    if ($CommandArgs.Count -eq 2) {
        if ($CommandArgs[0] -eq 'serve' -and $CommandArgs[1].StartsWith('--preset=') -and $CommandArgs[1].Length -gt 9) { return $true }
        if ($CommandArgs[0] -eq '--preset' -and -not [string]::IsNullOrEmpty($CommandArgs[1]) -and -not $CommandArgs[1].StartsWith('-')) { return $true }
        return $false
    }
    if ($CommandArgs.Count -eq 3 -and $CommandArgs[0] -eq 'serve' -and $CommandArgs[1] -eq '--preset' -and -not [string]::IsNullOrEmpty($CommandArgs[2]) -and -not $CommandArgs[2].StartsWith('-')) { return $true }
    return $false
}

function Resolve-ExecTarget {
    param([string]$Cli, [string[]]$CommandArgs)
    $dir = Split-Path -Parent $Cli
    $proxy = Join-Path $dir 'proxy.js'
    if ((Test-CliFile $proxy) -and (Test-PlainServe $CommandArgs) -and (Test-DaemonPortOpen)) {
        return $proxy
    }
    return $Cli
}

# --- 3. Fast path: config is good -> exec directly ---
#
# "Good" means the recorded pair still exists AND the recorded node still runs;
# a config that stopped describing reality heals itself here instead of failing
# forever.
# Only the NODE override exempts a run from the gate. Sharing one flag with
# TRACE_MCP_CLI_OVERRIDE would let a CLI-only debugging override carry the
# configured node past the check - the exact failure this gate exists to stop.
if (-not $UsingNodeOverride -and (Test-NodeBinary $NodePath) -and -not (Test-RuntimeShim $NodePath)) {
    Write-LauncherLog "ERROR: config node=$NodePath is an app runtime shim whose target is gone (app updated, moved or removed) - reprobing"
    $NodePath = ''
}

# An app runtime (Electron with Hardened Runtime / ABI 145) can only run the
# server bundled inside the app. Exec-ing an external npm package fails with
# ABI mismatch.
if (-not $UsingOverride -and (Test-AppRuntime $NodePath) -and $CliPath) {
    if ($CliPath -notmatch '[\\/]trace-mcp\.app[\\/]' -and $CliPath -notmatch '[\\/]Contents[\\/]Resources[\\/]server[\\/]dist[\\/]cli\.js') {
        Write-LauncherLog "ERROR: app runtime node=$NodePath cannot load external package cli=$CliPath (ABI mismatch) - reprobing"
        $CliPath = ''
    }
}

# The version gate is also the liveness gate, and it runs on EVERY start.
#
# It used to be skipped whenever the config carried a cached
# TRACE_MCP_NODE_MAJOR. But the question the fast path needs answered is not
# "which major is this" but "does this binary still run at all", and a file
# check cannot answer it: a node broken in place - a runtime uninstalled from
# under its own shim, an arch mismatch after a machine migration - still passes
# Test-NodeBinary, so the launcher started it, the start succeeded from its own
# side, and nothing was logged and nothing healed. The client lost every tool
# for the rest of the session and each later start repeated it (TRA-1040).
# TRACE_MCP_NODE_MAJOR is no longer read or written.
if (-not $UsingNodeOverride -and (Test-NodeBinary $NodePath)) {
    $probed = Get-NodeMajor $NodePath
    $verified = if ($null -eq $probed) { 0 } else { $probed }
    if ($verified -lt $NodeMinMajor) {
        if ($verified -eq 0) {
            Write-LauncherLog "ERROR: config node=$NodePath exists but cannot run (broken install, moved runtime or arch mismatch) - reprobing"
        } else {
            Write-LauncherLog "config node=$NodePath is node $verified, need >= $NodeMinMajor - reprobing"
        }
        $NodePath = ''
    }
}

if ((Test-NodeBinary $NodePath) -and (Test-CliFile $CliPath)) {
    $execTarget = Resolve-ExecTarget $CliPath $args
    Write-LauncherLog "exec(config) node=$NodePath cli=$CliPath target=$execTarget argc=$($args.Count)"
    if (Test-AppRuntime $NodePath) { $env:ELECTRON_RUN_AS_NODE = '1' }
    & $NodePath $execTarget @args
    exit $LASTEXITCODE
}

# Candidate user profiles to probe for node managers and global packages.
# Survives MCP clients spawned with an isolated or modified USERPROFILE.
function Get-CandidateProfiles {
    $profiles = @()
    if ($env:USERPROFILE -and (Test-Path -LiteralPath $env:USERPROFILE -PathType Container)) {
        $profiles += $env:USERPROFILE
    }
    if ($TraceHome) {
        $thName = Split-Path -Leaf $TraceHome
        $thParent = Split-Path -Parent $TraceHome
        if (($thName -eq '.trace' -or $thName -eq '.trace-mcp') -and $thParent -and (Test-Path -LiteralPath $thParent -PathType Container)) {
            $profiles += $thParent
        }
    }
    return ($profiles | Select-Object -Unique)
}

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

    # 4b. Volta (stable shim dir across candidate profiles)
    foreach ($profile in (Get-CandidateProfiles)) {
        $volta = Join-Path $profile '.volta\bin\node.exe'
        if (Test-NodeBinary $volta) { $found += $volta }
    }

    # 4c. nvm-windows: $APPDATA\nvm\<ver>\node.exe; active one symlinked via %NVM_SYMLINK%
    if ($env:NVM_SYMLINK) {
        $nvmActive = Join-Path $env:NVM_SYMLINK 'node.exe'
        if (Test-NodeBinary $nvmActive) { $found += $nvmActive }
    }
    $nvmRoot = Join-Path $env:APPDATA 'nvm'
    if (Test-Path -LiteralPath $nvmRoot -PathType Container) {
        $versions = Get-ChildItem -LiteralPath $nvmRoot -Directory -ErrorAction SilentlyContinue |
                    Where-Object { $_.Name -match '^v?\d+\.\d+\.\d+$' } |
                    Sort-Object -Property {
                        $clean = $_.Name.TrimStart('v')
                        try { [version]$clean } catch { [version]'0.0.0' }
                    } -Descending
        foreach ($v in $versions) {
            $candidate = Join-Path $v.FullName 'node.exe'
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
    # pnpm global roots
    foreach ($base in @($env:LOCALAPPDATA, $env:APPDATA)) {
        if (-not $base) { continue }
        $pnpmGlobal = Join-Path $base 'pnpm\global'
        if (Test-Path -LiteralPath $pnpmGlobal -PathType Container) {
            Get-ChildItem -LiteralPath $pnpmGlobal -Directory -ErrorAction SilentlyContinue | ForEach-Object {
                $m = Join-Path $_.FullName 'node_modules'
                if (Test-Path -LiteralPath $m -PathType Container) { $roots += $m }
            }
        }
        $pnpmRoot = Join-Path $base 'pnpm\node_modules'
        if (Test-Path -LiteralPath $pnpmRoot -PathType Container) { $roots += $pnpmRoot }
    }
    # Custom prefixes (`npm config set prefix`). Read from config files, never
    # by spawning npm: the shim inherits the MCP client's PATH, which in
    # a project directory can contain a repository-controlled `node_modules\.bin`,
    # so spawning a PATH-resolved npm would turn a stale config into code
    # execution from the opened repository.
    $prefix = $env:NPM_CONFIG_PREFIX
    if (-not $prefix) {
        foreach ($profile in (Get-CandidateProfiles)) {
            $npmrc = Join-Path $profile '.npmrc'
            foreach ($line in (Read-LauncherLines $npmrc)) {
                if ($line -match '^\s*prefix\s*=\s*(.+?)\s*$') {
                    $prefix = $Matches[1].Trim('"').Trim("'")
                    break
                }
            }
            if ($prefix) { break }
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
        if (Test-CliFile $c) {
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
        # Newest first: the suffix is the crashed updater's PID, so name order
        # says nothing about which copy is more recent (TRA-881).
        $bak = Get-ChildItem -LiteralPath $r -Directory -ErrorAction SilentlyContinue |
               Where-Object { $_.Name -like 'trace-mcp.tmcp-bak-*' -or $_.Name -like '.trace-mcp-*' } |
               Sort-Object @{ Expression = { if ($_.Name -like 'trace-mcp.tmcp-bak-*') { 0 } else { 1 } } },
                           @{ Expression = 'LastWriteTime'; Descending = $true } |
               ForEach-Object { Join-Path $_.FullName 'dist\cli.js' } |
               Where-Object { Test-CliFile $_ } |
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
    Write-LauncherLog "probe: node=$NodePath"
    $Healed = $true
}

if (-not (Test-CliFile $CliPath)) {
    $CliPath = Find-Cli $NodePath
    if (-not $CliPath) {
        $retry = 0
        while ($retry -lt 5 -and -not $CliPath) {
            Start-Sleep -Milliseconds 300
            $retry++
            $CliPath = Find-Cli $NodePath
        }
        if (-not $CliPath) {
            Die 'trace-mcp package not found in any known npm prefix - run: npm i -g trace-mcp && trace-mcp init'
        }
    }
    Write-LauncherLog "probe: cli=$CliPath"
    $Healed = $true
}

# Overrides are a debugging escape hatch; never bake them into the config.
if ($Healed -and -not $UsingOverride) { Save-LauncherConfig $NodePath $CliPath }

$execTarget = Resolve-ExecTarget $CliPath $args
Write-LauncherLog "exec(probe) node=$NodePath cli=$CliPath target=$execTarget argc=$($args.Count)"
if (Test-AppRuntime $NodePath) { $env:ELECTRON_RUN_AS_NODE = '1' }
& $NodePath $execTarget @args
exit $LASTEXITCODE
