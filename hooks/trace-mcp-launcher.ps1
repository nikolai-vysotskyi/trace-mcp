# trace-mcp-launcher v0.2.0 (Windows)
# Stable shim backend: resolves node + cli.js at runtime from launcher.env,
# with a probe fallback for nvm-windows/nvs/Volta/system installs.
# Managed by trace-mcp — do not edit by hand. Re-run `trace-mcp init` to refresh.

#Requires -Version 5.1

$ErrorActionPreference = 'Stop'

$TraceHome = if ($env:TRACE_MCP_HOME) { $env:TRACE_MCP_HOME } else { Join-Path $env:USERPROFILE '.trace-mcp' }
$ConfigPath = Join-Path $TraceHome 'launcher.env'
$LogPath    = Join-Path $TraceHome 'launcher.log'

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
if ($env:TRACE_MCP_NODE_OVERRIDE) { $NodePath = $env:TRACE_MCP_NODE_OVERRIDE }
if ($env:TRACE_MCP_CLI_OVERRIDE)  { $CliPath  = $env:TRACE_MCP_CLI_OVERRIDE }

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

# --- 3. Fast path: config is good → exec directly ---
if ((Test-NodeBinary $NodePath) -and (Test-CliFile $CliPath)) {
    Write-LauncherLog "exec(config) node=$NodePath cli=$CliPath argc=$($args.Count)"
    & $NodePath $CliPath @args
    exit $LASTEXITCODE
}

# --- 4. Probe fallback (stable sources only) ---

function Find-Node {
    # 4a. System-wide official installer
    $candidates = @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-NodeBinary $c)) { return $c }
    }

    # 4b. Volta (stable shim dir)
    $volta = Join-Path $env:USERPROFILE '.volta\bin\node.exe'
    if (Test-NodeBinary $volta) { return $volta }

    # 4c. nvm-windows: $APPDATA\nvm\<ver>\node.exe; active one symlinked via %NVM_SYMLINK%
    if ($env:NVM_SYMLINK) {
        $nvmActive = Join-Path $env:NVM_SYMLINK 'node.exe'
        if (Test-NodeBinary $nvmActive) { return $nvmActive }
    }
    $nvmRoot = Join-Path $env:APPDATA 'nvm'
    if (Test-Path -LiteralPath $nvmRoot -PathType Container) {
        $latest = Get-ChildItem -LiteralPath $nvmRoot -Directory -ErrorAction SilentlyContinue |
                  Where-Object { $_.Name -match '^v?\d+\.\d+\.\d+$' } |
                  Sort-Object -Property Name -Descending |
                  Select-Object -First 1
        if ($latest) {
            $candidate = Join-Path $latest.FullName 'node.exe'
            if (Test-NodeBinary $candidate) { return $candidate }
        }
    }

    # 4d. nvs: %LOCALAPPDATA%\nvs\default\<arch>\<ver>\node.exe (default alias)
    $nvsDefault = Join-Path $env:LOCALAPPDATA 'nvs\default'
    if (Test-Path -LiteralPath $nvsDefault -PathType Container) {
        $nodeExe = Get-ChildItem -LiteralPath $nvsDefault -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue |
                   Select-Object -First 1
        if ($nodeExe) { return $nodeExe.FullName }
    }

    return $null
}

function Find-Cli {
    param([string]$NodeExe)
    # npm-global layout on Windows places global modules in %APPDATA%\npm\node_modules\,
    # not next to node.exe. Check both layouts for robustness.
    $candidates = @(
        (Join-Path $env:APPDATA 'npm\node_modules\trace-mcp\dist\cli.js'),
        (Join-Path (Split-Path -Parent $NodeExe) 'node_modules\trace-mcp\dist\cli.js'),
        # Unix-style layout (some cross-platform setups)
        (Join-Path (Split-Path -Parent $NodeExe) '..\lib\node_modules\trace-mcp\dist\cli.js')
    )
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c -PathType Leaf) {
            return (Resolve-Path -LiteralPath $c).Path
        }
    }
    return $null
}

if (-not (Test-NodeBinary $NodePath)) {
    $NodePath = Find-Node
    if (-not $NodePath) {
        Die 'node binary not found — install Node.js (nodejs.org / nvs / nvm-windows / volta) or set TRACE_MCP_NODE_OVERRIDE'
    }
    Write-LauncherLog "probe: node=$NodePath"
}

if (-not (Test-CliFile $CliPath)) {
    $CliPath = Find-Cli $NodePath
    if (-not $CliPath) {
        Die "trace-mcp package not found for node=$NodePath — run: npm i -g trace-mcp && trace-mcp init"
    }
    Write-LauncherLog "probe: cli=$CliPath"
}

Write-LauncherLog "exec(probe) node=$NodePath cli=$CliPath argc=$($args.Count)"
& $NodePath $CliPath @args
exit $LASTEXITCODE
