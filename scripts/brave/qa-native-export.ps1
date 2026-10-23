param([int]$NativeAppPid, [string]$Preset = 'BalancedPreset', [switch]$AllowRecordingRetry)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
function Find-Control([string]$Identifier) {
    $nativeProcess = Get-Process -Id $NativeAppPid
    if ($nativeProcess.MainWindowHandle -eq 0) { return $null }
    $nativeRoot = [System.Windows.Automation.AutomationElement]::FromHandle($nativeProcess.MainWindowHandle)
    return $nativeRoot.FindFirst([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $Identifier))
}
$until = [DateTime]::UtcNow.AddSeconds(50)
$firstNote = $null
while ([DateTime]::UtcNow -lt $until) {
    $noteList = Find-Control 'NoteList'
    if ($noteList) { $firstNote = $noteList.FindFirst([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)) }
    if ($firstNote) { break }; Start-Sleep -Milliseconds 250
}
if (-not $firstNote) { $status = Find-Control 'StatusText'; throw ('The native library did not load: ' + $status.Current.Name) }
$firstNote.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
(Find-Control $Preset).GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
$until = [DateTime]::UtcNow.AddSeconds(30)
while ([DateTime]::UtcNow -lt $until) {
    $export = Find-Control 'ExportButton'; if ($export -and $export.Current.IsEnabled) { break }
    if ($AllowRecordingRetry) { $reload = Find-Control 'LoadRecordingsButton'; if ($reload -and -not $reload.Current.IsOffscreen -and $reload.Current.IsEnabled) { $reload.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $AllowRecordingRetry = $false } }
    Start-Sleep -Milliseconds 200
}
if (-not $export.Current.IsEnabled) { $status = Find-Control 'StatusText'; throw ('Native export did not become available: ' + $status.Current.Name) }
$export.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
Start-Sleep -Milliseconds 600
$status = Find-Control 'StatusText'
$heading = Find-Control 'QueueHeading'
@{ action='Native UI export invoked'; status=$status.Current.Name; queue=$heading.Current.Name } | ConvertTo-Json -Compress
