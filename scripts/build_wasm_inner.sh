#!/bin/bash
# Container-side WASM build steps (invoked by build_wasm_docker.sh / .ps1).

set -euo pipefail

: "${BUILD_DIR:=build-wasm}"
: "${WASM_OUT_DIR:=wasm}"
: "${ENABLE_PERFORMANCE_DIAGNOSTICS:=OFF}"
: "${ENABLE_WASM_SIMD:=OFF}"
: "${FAR_FIELD_OPTIMIZATIONS:=SELECTED}"

# Build on the container filesystem. Windows bind mounts (/mnt/c/...) reject
# writes from a non-root container user, which breaks emscripten link steps.
CONTAINER_BUILD_DIR="/tmp/necpp-${BUILD_DIR}"

rm -f \
    packages/necpp-wasm/src/nec2pp.generated.js \
    packages/necpp-wasm/src/nec2pp.wasm \
    packages/necpp-wasm/src/necpp-field-evaluator.generated.js \
    packages/necpp-wasm/src/necpp-field-evaluator.wasm
rm -f "$WASM_OUT_DIR/nec2pp.d.ts"
rm -rf "$CONTAINER_BUILD_DIR"

CXX_FLAGS="-O3 -DNDEBUG -flto -fexceptions"
if [[ "$ENABLE_WASM_SIMD" == "ON" ]]; then
    CXX_FLAGS="$CXX_FLAGS -msimd128"
fi
LINK_FLAGS="-O3 -flto \
-sMODULARIZE=1 \
-sEXPORT_ES6=1 \
-sEXPORT_NAME=createNecModule \
-sENVIRONMENT=web,worker,node \
-sINVOKE_RUN=0 \
-sEXIT_RUNTIME=0 \
-sALLOW_MEMORY_GROWTH=1 \
-sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAP32,HEAPF64 \
-sDISABLE_EXCEPTION_CATCHING=0"
if [[ "$ENABLE_WASM_SIMD" == "ON" ]]; then
    LINK_FLAGS="$LINK_FLAGS -msimd128"
fi

emcmake cmake -B "$CONTAINER_BUILD_DIR" -S . \
    -DCMAKE_BUILD_TYPE=Release \
    -DNECPP_BUILD_WASM=ON \
    -DNECPP_BUILD_TESTS=OFF \
    -DNECPP_ENABLE_PERFORMANCE_DIAGNOSTICS="$ENABLE_PERFORMANCE_DIAGNOSTICS" \
    -DNECPP_FAR_FIELD_OPTIMIZATIONS="$FAR_FIELD_OPTIMIZATIONS" \
    -DBUILD_SHARED_LIBS=OFF \
    "-DCMAKE_CXX_FLAGS_RELEASE=$CXX_FLAGS" \
    "-DCMAKE_EXE_LINKER_FLAGS_RELEASE=$LINK_FLAGS"

cmake --build "$CONTAINER_BUILD_DIR" --config Release -j"$(nproc)"

test -s "$CONTAINER_BUILD_DIR/src/nec2pp.js"
test -s "$CONTAINER_BUILD_DIR/src/nec2pp.wasm"
test -s "$CONTAINER_BUILD_DIR/src/necpp-field-evaluator.js"
test -s "$CONTAINER_BUILD_DIR/src/necpp-field-evaluator.wasm"

cp "$CONTAINER_BUILD_DIR/src/nec2pp.js" \
    packages/necpp-wasm/src/nec2pp.generated.js
cp "$CONTAINER_BUILD_DIR/src/nec2pp.wasm" \
    packages/necpp-wasm/src/nec2pp.wasm
cp "$CONTAINER_BUILD_DIR/src/necpp-field-evaluator.js" \
    packages/necpp-wasm/src/necpp-field-evaluator.generated.js
cp "$CONTAINER_BUILD_DIR/src/necpp-field-evaluator.wasm" \
    packages/necpp-wasm/src/necpp-field-evaluator.wasm

mkdir -p "$WASM_OUT_DIR"

cp \
    "$CONTAINER_BUILD_DIR/src/nec2pp.js" \
    "$CONTAINER_BUILD_DIR/src/nec2pp.wasm" \
    "$CONTAINER_BUILD_DIR/src/necpp-field-evaluator.js" \
    "$CONTAINER_BUILD_DIR/src/necpp-field-evaluator.wasm" \
    "$WASM_OUT_DIR/"
