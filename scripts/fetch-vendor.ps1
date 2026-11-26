# Fetches the prebuilt Windows runtimes that are too large to commit.
# Reproduces README steps 2, 4 and 5; used by .github/workflows/release.yml.
#
#   pwsh scripts/fetch-vendor.ps1
#
# Everything lands under apps/desktop/src-tauri/vendor/ and is gitignored.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
$tauri = Join-Path $root 'apps/desktop/src-tauri'
$vendor = Join-Path $tauri 'vendor'
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("livetrans-vendor-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

function Get-File([string]$url, [string]$out) {
    Write-Host "download $url"
    Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
}

try {
    # sherpa-onnx shared C API (see README step 2).
    $sherpaDir = Join-Path $vendor 'sherpa'
    New-Item -ItemType Directory -Force -Path $sherpaDir | Out-Null
    $sherpaArchive = Join-Path $tmp 'sherpa.tar.bz2'
    Get-File 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v2.0.3/sherpa-onnx-v2.0.3-win-x64-shared-MT-Release-lib.tar.bz2' $sherpaArchive
    tar -xjf $sherpaArchive -C $sherpaDir --strip-components=2 `
        'sherpa-onnx-v2.0.3-win-x64-shared-MT-Release-lib/lib/sherpa-onnx-c-api.dll' `
        'sherpa-onnx-v2.0.3-win-x64-shared-MT-Release-lib/lib/sherpa-onnx-cxx-api.dll'
    if ($LASTEXITCODE -ne 0) { throw 'tar failed to extract sherpa-onnx DLLs' }

    # ONNX Runtime DLL for ort's load-dynamic mode (see README step 5).
    # NuGet is the stable source; the GitHub asset URL is not always reachable.
    $ortVersion = '1.28.0'
    $ortDir = Join-Path $vendor 'onnxruntime'
    New-Item -ItemType Directory -Force -Path $ortDir | Out-Null
    $ortPackage = Join-Path $tmp 'onnxruntime.nupkg'
    Get-File "https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/$ortVersion/microsoft.ml.onnxruntime.$ortVersion.nupkg" $ortPackage
    $ortUnpack = Join-Path $tmp 'onnxruntime'
    Expand-Archive -Path $ortPackage -DestinationPath $ortUnpack -Force
    $native = Join-Path $ortUnpack 'runtimes/win-x64/native'
    Copy-Item (Join-Path $native 'onnxruntime.dll') $ortDir -Force
    $providers = Join-Path $native 'onnxruntime_providers_shared.dll'
    if (Test-Path $providers) { Copy-Item $providers $ortDir -Force }

    # Silero VAD used by the Whisper path; small enough to ship.
    $vadDir = Join-Path $vendor 'vad'
    New-Item -ItemType Directory -Force -Path $vadDir | Out-Null
    Get-File 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx' (Join-Path $vadDir 'silero_vad.onnx')

    Write-Host 'vendor runtimes ready:'
    Get-ChildItem -Path $vendor -Recurse -File | ForEach-Object {
        '{0,10:N0}  {1}' -f $_.Length, $_.FullName.Substring($vendor.Length + 1)
    }
}
finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
