param([switch]$Once)
$ErrorActionPreference = 'Stop'
$runtimeDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\binance-collector'))
$encryptedPath = Join-Path $runtimeDirectory 'credentials.dpapi'
$secureConfiguration = Get-Content -LiteralPath $encryptedPath -Raw | ConvertTo-SecureString
$nativeString = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureConfiguration)
try {
    $configuration = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($nativeString)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($nativeString)
}
$nodeExecutable = 'C:\Users\19233\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$collectorScript = Join-Path $PSScriptRoot 'binance-collector.mjs'
$startInfo = [Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName = $nodeExecutable
$startInfo.ArgumentList.Add($collectorScript)
if ($Once) { $startInfo.ArgumentList.Add('--once') }
$startInfo.UseShellExecute = $false
$startInfo.CreateNoWindow = $true
$startInfo.RedirectStandardInput = $true
$collectorProcess = [Diagnostics.Process]::Start($startInfo)
try {
    $collectorProcess.StandardInput.WriteLine($configuration)
    $collectorProcess.StandardInput.Close()
    $configuration = ''
    $secureConfiguration.Dispose()
    $collectorProcess.WaitForExit()
    exit $collectorProcess.ExitCode
} finally {
    $configuration = ''
    $collectorProcess.Dispose()
}
