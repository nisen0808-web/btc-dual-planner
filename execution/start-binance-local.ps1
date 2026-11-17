[CmdletBinding()]
param(
    [string]$Runtime = (Join-Path $PSScriptRoot '..\..\..\binance-execution'),
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$nodePath = 'C:\Users\19233\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$serverPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'binance-local-server.mjs'))
$runtimePath = [System.IO.Path]::GetFullPath($Runtime).TrimEnd('\')
$pidPath = Join-Path $runtimePath 'binance-local-server.pid'
$setupUrl = 'http://127.0.0.1:8789/setup'

function Test-BoundProcess([int]$ProcessId) {
    $process = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId={0}' -f $ProcessId) -ErrorAction Stop
    if ($null -eq $process) { return $false }
    if (-not [string]::Equals($process.ExecutablePath, $nodePath, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    $serverPattern = '(?i)(?:^|\s)(?:"' + [regex]::Escape($serverPath) + '"|' + [regex]::Escape($serverPath) + ')(?=\s|$)'
    $runtimePattern = '(?i)(?:^|\s)--runtime\s+(?:"' + [regex]::Escape($runtimePath) + '"|' + [regex]::Escape($runtimePath) + ')(?=\s|$)'
    return $process.CommandLine -match $serverPattern -and $process.CommandLine -match $runtimePattern
}
function Get-ServiceHealth {
    try {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8789/health' -Method Get -TimeoutSec 2 -MaximumRedirection 0
        return $health.service -eq 'binance-local-execution'
    } catch { return $false }
}
function Open-Setup {
    if (-not $NoBrowser) { Start-Process -FilePath $setupUrl | Out-Null }
    Write-Output ('Local account setup: ' + $setupUrl)
}

if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw 'The bundled Node runtime is unavailable.' }
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw 'The local execution server file is unavailable.' }
if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
    $pidText = (Get-Content -LiteralPath $pidPath -Raw).Trim()
    if ($pidText -notmatch '^[1-9]\d{0,9}$' -or [long]$pidText -gt [int]::MaxValue) { throw 'The local server PID record is invalid; no process was started.' }
    $recordedPid = [int]$pidText
    $existing = Get-Process -Id $recordedPid -ErrorAction SilentlyContinue
    if ($null -ne $existing) {
        if (-not (Test-BoundProcess $recordedPid)) { throw 'The PID belongs to a different process; no process was started or stopped.' }
        if (-not (Get-ServiceHealth)) { throw 'The matching local server is running but not healthy. Check it before restarting.' }
        Open-Setup
        exit 0
    }
}
if (Get-ServiceHealth) { throw 'A local execution service already uses port 8789 without a matching PID. No second service was started.' }
New-Item -ItemType Directory -Path $runtimePath -Force | Out-Null
$arguments = @('"' + $serverPath + '"', '--runtime', '"' + $runtimePath + '"')
$started = Start-Process -FilePath $nodePath -ArgumentList $arguments -WorkingDirectory (Split-Path $PSScriptRoot -Parent) -WindowStyle Hidden -PassThru
$deadline = [DateTime]::UtcNow.AddSeconds(25)
do {
    Start-Sleep -Milliseconds 350
    $started.Refresh()
    if ($started.HasExited) { throw 'The local execution server stopped before it became ready.' }
    if ((Test-Path -LiteralPath $pidPath -PathType Leaf) -and (Get-ServiceHealth)) {
        $pidText = (Get-Content -LiteralPath $pidPath -Raw).Trim()
        if ($pidText -eq [string]$started.Id -and (Test-BoundProcess $started.Id)) {
            Open-Setup
            exit 0
        }
    }
} while ([DateTime]::UtcNow -lt $deadline)
throw 'The local server has not become healthy. No additional instance was started; inspect the existing process.'
