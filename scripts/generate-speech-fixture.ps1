param([Parameter(Mandatory=$true)][string]$OutputFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $speaker.SetOutputToWaveFile([IO.Path]::GetFullPath($OutputFile))
    $speaker.Speak('The anterior abdominal wall contains several layers of muscle. Preserve the medical terminology and the final sentence of this lecture.')
} finally { $speaker.Dispose() }
