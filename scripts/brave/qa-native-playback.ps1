param([int]$NativeAppPid)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$nativeProcess = Get-Process -Id $NativeAppPid
$root = [System.Windows.Automation.AutomationElement]::FromHandle($nativeProcess.MainWindowHandle)
function Find-ById([string]$Identifier) {
    $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $Identifier))
}
$queue = Find-ById 'QueueList'
$preview = $queue.FindFirst([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, 'Preview'))
if (-not $preview) { throw 'The completed native export has no Preview action.' }
$preview.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
$until = [DateTime]::UtcNow.AddSeconds(15)
while ([DateTime]::UtcNow -lt $until) {
    $time = Find-ById 'PlaybackTime'
    if ($time.Current.Name -match '\d+:\d+ / 0:0[3-5]') {
        $stop = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, 'Stop'))
        $stop.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        Write-Output 'Native Windows media playback opened and decoded the exported lecture (muted QA).'
        exit 0
    }
    Start-Sleep -Milliseconds 200
}
$status = Find-ById 'StatusText'
throw ('Native playback did not decode the exported lecture: ' + $status.Current.Name)
