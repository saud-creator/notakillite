$ErrorActionPreference = 'Stop'
$outputDirectory = Join-Path $PSScriptRoot 'notability-public'
$appHtml = (Invoke-WebRequest -Uri 'https://notability.com/app' -UseBasicParsing).Content
[System.IO.File]::WriteAllText((Join-Path $outputDirectory 'app.html'), $appHtml)
$assets = [regex]::Matches($appHtml, '(?:src|href)="(/app/assets/[^" ]+\.js)"') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique
$assets += '/app/assets/App-YcOgtQwd.js'
$assets += '/app/assets/SharedWorkerEntrypoint-D2wjn_E1.js'
foreach ($asset in $assets) {
  $filename = [System.IO.Path]::GetFileName($asset)
  if (Test-Path -LiteralPath (Join-Path $outputDirectory $filename)) { continue }
  Invoke-WebRequest -Uri ('https://notability.com' + $asset) -OutFile (Join-Path $outputDirectory $filename)
  Write-Output $filename
}
