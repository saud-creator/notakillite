param([ValidateSet('Install','Remove')][string]$Action, [Parameter(Mandatory=$true)][string]$ManifestPath)
$ErrorActionPreference = 'Stop'
$manifestAbsolute = [IO.Path]::GetFullPath($ManifestPath)
$testRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\.local\bridge-native-qa')) + [IO.Path]::DirectorySeparatorChar
if (-not $manifestAbsolute.StartsWith($testRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'QA manifest must be inside this project test directory.' }
foreach ($keyPath in @('HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.notakillite.qa','HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.notakillite.qa')) {
    if (Test-Path -LiteralPath $keyPath) {
        $previous = (Get-Item -LiteralPath $keyPath).GetValue('')
        if ($previous -and $previous -ne $manifestAbsolute) { throw 'An unrelated QA host registration already exists.' }
    }
    if ($Action -eq 'Install') { New-Item -Path $keyPath -Force | Out-Null; Set-Item -LiteralPath $keyPath -Value $manifestAbsolute }
    elseif (Test-Path -LiteralPath $keyPath) { Remove-Item -LiteralPath $keyPath }
}
Write-Output ('QA native host registration: ' + $Action)
