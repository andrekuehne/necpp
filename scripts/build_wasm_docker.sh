#!/bin/bash
# Build the reusable NEC++ WebAssembly module inside the Emscripten Docker image.
#
# Produces in the repository root:
#   nec2pp.js
#   nec2pp.wasm
#   nec2pp.d.ts

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="build-wasm"
WASM_IMAGE="emscripten/emsdk:4.0.7"

cd "$PROJECT_DIR"

rm -f nec2pp.js nec2pp.wasm nec2pp.d.ts

echo "=== Building WASM via Emscripten Docker image: $WASM_IMAGE ==="

docker run --rm \
    --user "$(id -u):$(id -g)" \
    -e BUILD_DIR="$BUILD_DIR" \
    -v "$PROJECT_DIR:/src" \
    -w /src \
    "$WASM_IMAGE" \
    bash -c '
        set -euo pipefail

        TS_TOOLS_DIR="/tmp/emscripten-ts-tools"
        export npm_config_cache="/tmp/npm-cache"

        npm install \
            --prefix "$TS_TOOLS_DIR" \
            --no-save \
            --no-package-lock \
            typescript@5.8.3
        
        export PATH="$TS_TOOLS_DIR/node_modules/.bin:$PATH"
        
        tsc --version

        rm -rf "$BUILD_DIR"

        CXX_FLAGS="-O3 -DNDEBUG -flto"
        LINK_FLAGS="-O3 -flto \
-sMODULARIZE=1 \
-sEXPORT_ES6=1 \
-sEXPORT_NAME=createNecModule \
-sENVIRONMENT=web,worker \
-sINVOKE_RUN=0 \
-sEXIT_RUNTIME=0 \
-sALLOW_MEMORY_GROWTH=1 \
-sFILESYSTEM=1 \
-sEXPORTED_RUNTIME_METHODS=FS,callMain \
--emit-tsd nec2pp.d.ts"

        emcmake cmake -B "$BUILD_DIR" -S . \
            -DCMAKE_BUILD_TYPE=Release \
            -DNECPP_BUILD_WASM=ON \
            -DNECPP_BUILD_TESTS=OFF \
            -DBUILD_SHARED_LIBS=OFF \
            "-DCMAKE_CXX_FLAGS_RELEASE=$CXX_FLAGS" \
            "-DCMAKE_EXE_LINKER_FLAGS_RELEASE=$LINK_FLAGS"

        cmake --build "$BUILD_DIR" --config Release -j"$(nproc)"

        test -s "$BUILD_DIR/src/nec2pp.js"
        test -s "$BUILD_DIR/src/nec2pp.wasm"
        test -s "$BUILD_DIR/src/nec2pp.d.ts"

        cp \
            "$BUILD_DIR/src/nec2pp.js" \
            "$BUILD_DIR/src/nec2pp.wasm" \
            "$BUILD_DIR/src/nec2pp.d.ts" \
            .
    '

echo "=== WASM build complete ==="
