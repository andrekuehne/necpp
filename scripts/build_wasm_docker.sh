#!/bin/bash
# Build the reusable NEC++ WebAssembly module inside the Emscripten Docker image.
#
# Produces in wasm/:
#   nec2pp.js
#   nec2pp.wasm

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="build-wasm"
WASM_IMAGE="emscripten/emsdk:4.0.7"

cd "$PROJECT_DIR"

node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)' || {
    echo "Node 24 or later is required to build and test the WASM package" >&2
    exit 1
}
npm --prefix packages/necpp-wasm ci

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

node scripts/wasm_smoke_test.mjs packages/necpp-wasm/src/nec2pp.generated.js
npm --prefix packages/necpp-wasm run test:wasm

echo "=== WASM build complete ==="
