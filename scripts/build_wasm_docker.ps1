# Build the reusable NEC++ WebAssembly module inside the Emscripten Docker image.
#
# Produces in wasm/:
#   nec2pp.js
#   nec2pp.wasm
#
# Usage (from repo root or scripts/):
#   .\scripts\build_wasm_docker.ps1

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Resolve-Path (Join-Path $ScriptDir "..")
$BuildDir = "build-wasm"
$WasmImage = "emscripten/emsdk:4.0.7"
$EnablePerformanceDiagnostics = if ($env:NECPP_ENABLE_PERFORMANCE_DIAGNOSTICS) {
    $env:NECPP_ENABLE_PERFORMANCE_DIAGNOSTICS
} else { "OFF" }
$EnableWasmSimd = if ($env:NECPP_ENABLE_WASM_SIMD) {
    $env:NECPP_ENABLE_WASM_SIMD
} else { "OFF" }

Set-Location $ProjectDir

$NodeMajor = node -p "Number(process.versions.node.split('.')[0])"
if ($LASTEXITCODE -ne 0 -or [int]$NodeMajor -lt 24) {
    throw "Node 24 or later is required to build and test the WASM package"
}

npm --prefix packages/necpp-wasm ci
if ($LASTEXITCODE -ne 0) {
    throw "npm ci failed with exit code $LASTEXITCODE"
}

$WasmOutDir = Join-Path $ProjectDir "wasm"
New-Item -ItemType Directory -Force -Path $WasmOutDir | Out-Null

Remove-Item -ErrorAction SilentlyContinue `
    (Join-Path $WasmOutDir "nec2pp.js"), `
    (Join-Path $WasmOutDir "nec2pp.wasm"), `
    (Join-Path $WasmOutDir "nec2pp.d.ts")

Write-Host "=== Building WASM via Emscripten Docker image: $WasmImage ==="

docker run --rm `
    -e "BUILD_DIR=$BuildDir" `
    -e "ENABLE_PERFORMANCE_DIAGNOSTICS=$EnablePerformanceDiagnostics" `
    -e "ENABLE_WASM_SIMD=$EnableWasmSimd" `
    -v "${ProjectDir}:/src" `
    -w /src `
    $WasmImage `
    bash scripts/build_wasm_inner.sh

if ($LASTEXITCODE -ne 0) {
    throw "Docker build failed with exit code $LASTEXITCODE"
}

node scripts/wasm_smoke_test.mjs packages/necpp-wasm/src/nec2pp.generated.js
if ($LASTEXITCODE -ne 0) {
    throw "WASM smoke test failed with exit code $LASTEXITCODE"
}

npm --prefix packages/necpp-wasm run test:wasm
if ($LASTEXITCODE -ne 0) {
    throw "WASM package tests failed with exit code $LASTEXITCODE"
}

Write-Host "=== WASM build complete ==="
