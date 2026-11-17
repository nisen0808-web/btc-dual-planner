[CmdletBinding()]
param(
    [ValidateSet('Protect', 'Unprotect')]
    [string]$Mode = 'Protect'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$plainBytes = $null
$protectedBytes = $null

try {
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    Add-Type -AssemblyName System.Security | Out-Null
    $inputText = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrEmpty($inputText) -or $inputText.Length -gt 131072) {
        throw 'Invalid input size'
    }
    if ($Mode -eq 'Protect') {
        $plainBytes = [System.Text.Encoding]::UTF8.GetBytes($inputText)
        if ($plainBytes.Length -gt 65536) { throw 'Invalid input size' }
        $protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect(
            $plainBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        [Console]::Out.Write([Convert]::ToBase64String($protectedBytes))
    } else {
        $protectedBytes = [Convert]::FromBase64String($inputText.Trim())
        $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
            $protectedBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        if ($plainBytes.Length -gt 65536) { throw 'Invalid input size' }
        $strictUtf8 = [System.Text.UTF8Encoding]::new($false, $true)
        [Console]::Out.Write($strictUtf8.GetString($plainBytes))
    }
} catch {
    [Console]::Error.WriteLine('Local configuration protection failed.')
    exit 1
} finally {
    if ($null -ne $plainBytes) { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
    if ($null -ne $protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
    $inputText = $null
}
