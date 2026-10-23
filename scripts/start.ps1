#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$nativeExecutable = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\release\Notakillite.exe'))
if (-not (Test-Path -LiteralPath $nativeExecutable)) { throw 'Build Notakillite first with npm run build:exe.' }
Start-Process -FilePath $nativeExecutable -WindowStyle Normal