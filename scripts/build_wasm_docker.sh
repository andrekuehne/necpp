#!/bin/bash
# Build the reusable NEC++ WebAssembly module inside the Emscripten Docker image.
#
# Produces in wasm/:
#   nec2pp.js
#   nec2pp.wasm
#   nec2pp.d.ts

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="build-wasm"
WASM_IMAGE="emscripten/emsdk:4.0.7"

cd "$PROJECT_DIR"

rm -f wasm/nec2pp.js wasm/nec2pp.wasm wasm/nec2pp.d.ts
mkdir -p wasm

echo "=== Building WASM via Emscripten Docker image: $WASM_IMAGE ==="

docker run --rm \
    --user "$(id -u):$(id -g)" \
    -e BUILD_DIR="$BUILD_DIR" \
    -v "$PROJECT_DIR:/src" \
    -w /src \
    "$WASM_IMAGE" \
    bash scripts/build_wasm_inner.sh

echo "=== WASM build complete ==="
