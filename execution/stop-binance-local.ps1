[CmdletBinding()]
param(
    [string]$Runtime = (Join-Path $PSScriptRoot '..\..\..\binance-execution')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$nodePath = 'C:\Users\19233\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$serverPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'binance-local-server.mjs'))
$runtimePath = [System.IO.Path]::GetFullPath($Runtime).TrimEnd('\')
$pidPath = Join-Path $runtimePath 'binance-local-server.pid'

if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) {
    Write-Output 'No PID record exists for this local execution service.'
    exit 0
}
$pidText = (Get-Content -LiteralPath $pidPath -Raw).Trim()
if ($pidText -notmatch '^[1-9]\d{0,9}$' -or [long]$pidText -gt [int]::MaxValue) { throw 'The PID record is invalid. No process was stopped.' }
$recordedPid = [int]$pidText
$process = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId={0}' -f $recordedPid) -ErrorAction Stop
if ($null -ne $process) {
    $serverPattern = '(?i)(?:^|\s)(?:"' + [regex]::Escape($serverPath) + '"|' + [regex]::Escape($serverPath) + ')(?=\s|$)'
    $runtimePattern = '(?i)(?:^|\s)--runtime\s+(?:"' + [regex]::Escape($runtimePath) + '"|' + [regex]::Escape($runtimePath) + ')(?=\s|$)'
    if (-not [string]::Equals($process.ExecutablePath, $nodePath, [StringComparison]::OrdinalIgnoreCase) -or $process.CommandLine -notmatch $serverPattern -or $process.CommandLine -notmatch $runtimePattern) {
        throw 'The PID is not bound to this server and runtime. No process was stopped.'
    }
    Stop-Process -Id $recordedPid -ErrorAction Stop
    Wait-Process -Id $recordedPid -Timeout 10 -ErrorAction SilentlyContinue
    if (Get-Process -Id $recordedPid -ErrorAction SilentlyContinue) { throw 'The verified local server is still stopping. No other process was touched.' }
}
if ((Test-Path -LiteralPath $pidPath -PathType Leaf) -and ((Get-Content -LiteralPath $pidPath -Raw).Trim() -eq $pidText)) {
    Remove-Item -LiteralPath $pidPath -ErrorAction Stop
}
Write-Output 'The local execution service is stopped. Submitted orders still require reconciliation after restart.'
