param([int]$NativeAppPid)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$nativeProcess = Get-Process -Id $NativeAppPid -ErrorAction SilentlyContinue
if ($nativeProcess -and $nativeProcess.MainWindowHandle -ne 0) { $nativeRoot = [System.Windows.Automation.AutomationElement]::FromHandle($nativeProcess.MainWindowHandle); $nativeRoot.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close() }
