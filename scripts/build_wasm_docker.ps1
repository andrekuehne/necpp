# Build the reusable NEC++ WebAssembly module inside the Emscripten Docker image.
#
# Produces in wasm/:
#   nec2pp.js
#   nec2pp.wasm
#   nec2pp.d.ts
#
# Usage (from repo root or scripts/):
#   .\scripts\build_wasm_docker.ps1

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Resolve-Path (Join-Path $ScriptDir "..")
$BuildDir = "build-wasm"
$WasmImage = "emscripten/emsdk:4.0.7"

Set-Location $ProjectDir

$WasmOutDir = Join-Path $ProjectDir "wasm"
New-Item -ItemType Directory -Force -Path $WasmOutDir | Out-Null

Remove-Item -ErrorAction SilentlyContinue `
    (Join-Path $WasmOutDir "nec2pp.js"), `
    (Join-Path $WasmOutDir "nec2pp.wasm"), `
    (Join-Path $WasmOutDir "nec2pp.d.ts")

Write-Host "=== Building WASM via Emscripten Docker image: $WasmImage ==="

docker run --rm `
    -e "BUILD_DIR=$BuildDir" `
    -v "${ProjectDir}:/src" `
    -w /src `
    $WasmImage `
    bash scripts/build_wasm_inner.sh

if ($LASTEXITCODE -ne 0) {
    throw "Docker build failed with exit code $LASTEXITCODE"
}

Write-Host "=== WASM build complete ==="
