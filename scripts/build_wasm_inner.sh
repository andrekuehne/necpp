#!/bin/bash
# Container-side WASM build steps (invoked by build_wasm_docker.sh / .ps1).

set -euo pipefail

: "${BUILD_DIR:=build-wasm}"
: "${WASM_OUT_DIR:=wasm}"

# Build on the container filesystem. Windows bind mounts (/mnt/c/...) reject
# writes from a non-root container user, which breaks emscripten link steps.
CONTAINER_BUILD_DIR="/tmp/necpp-${BUILD_DIR}"

TS_TOOLS_DIR="/tmp/emscripten-ts-tools"
export npm_config_cache="/tmp/npm-cache"

npm install \
    --prefix "$TS_TOOLS_DIR" \
    --no-save \
    --no-package-lock \
    typescript@5.8.3

export PATH="$TS_TOOLS_DIR/node_modules/.bin:$PATH"

tsc --version

rm -f \
    packages/necpp-wasm/src/nec2pp.generated.js \
    packages/necpp-wasm/src/nec2pp.wasm
rm -rf "$CONTAINER_BUILD_DIR"

CXX_FLAGS="-O3 -DNDEBUG -flto -fexceptions"
LINK_FLAGS="-O3 -flto \
-sMODULARIZE=1 \
-sEXPORT_ES6=1 \
-sEXPORT_NAME=createNecModule \
-sENVIRONMENT=web,worker,node \
-sINVOKE_RUN=0 \
-sEXIT_RUNTIME=0 \
-sALLOW_MEMORY_GROWTH=1 \
-sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP32,HEAPF64 \
-sDISABLE_EXCEPTION_CATCHING=0 \
--emit-tsd nec2pp.d.ts"

emcmake cmake -B "$CONTAINER_BUILD_DIR" -S . \
    -DCMAKE_BUILD_TYPE=Release \
    -DNECPP_BUILD_WASM=ON \
    -DNECPP_BUILD_TESTS=OFF \
    -DBUILD_SHARED_LIBS=OFF \
    "-DCMAKE_CXX_FLAGS_RELEASE=$CXX_FLAGS" \
    "-DCMAKE_EXE_LINKER_FLAGS_RELEASE=$LINK_FLAGS"

cmake --build "$CONTAINER_BUILD_DIR" --config Release -j"$(nproc)"

test -s "$CONTAINER_BUILD_DIR/src/nec2pp.js"
test -s "$CONTAINER_BUILD_DIR/src/nec2pp.wasm"
test -s "$CONTAINER_BUILD_DIR/src/nec2pp.d.ts"

node --experimental-default-type=module \
    scripts/wasm_smoke_test.mjs \
    "$CONTAINER_BUILD_DIR/src/nec2pp.js"

cp "$CONTAINER_BUILD_DIR/src/nec2pp.js" \
    packages/necpp-wasm/src/nec2pp.generated.js
cp "$CONTAINER_BUILD_DIR/src/nec2pp.wasm" \
    packages/necpp-wasm/src/nec2pp.wasm

npm --prefix packages/necpp-wasm run test:wasm

mkdir -p "$WASM_OUT_DIR"

cp \
    "$CONTAINER_BUILD_DIR/src/nec2pp.js" \
    "$CONTAINER_BUILD_DIR/src/nec2pp.wasm" \
    "$CONTAINER_BUILD_DIR/src/nec2pp.d.ts" \
    "$WASM_OUT_DIR/"
