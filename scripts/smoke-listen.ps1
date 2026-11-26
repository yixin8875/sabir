# Smoke test for the installed build: focus the window, press Ctrl+M,
# then speak a few English sentences through the default output device so
# WASAPI loopback has something to capture.
$ErrorActionPreference = 'Stop'

$proc = Get-Process app -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { throw 'Sabir is not running' }

$ws = New-Object -ComObject WScript.Shell
$ws.AppActivate($proc.Id) | Out-Null
Start-Sleep -Milliseconds 900
$ws.SendKeys('^m')
Start-Sleep -Seconds 2

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$english = $synth.GetInstalledVoices() |
    Where-Object { $_.VoiceInfo.Culture.Name -like 'en-*' } |
    Select-Object -First 1
if ($english) { $synth.SelectVoice($english.VoiceInfo.Name) }
$synth.Rate = 0

$lines = @(
    'Good morning, everyone. Today we will talk about machine translation.',
    'The speech recognizer runs entirely on this computer.',
    'Nothing is uploaded to the cloud.',
    'Let us begin with the first example.'
)
foreach ($line in $lines) {
    $synth.Speak($line)
    Start-Sleep -Seconds 3
}
$synth.Dispose()
Write-Output 'spoken'
