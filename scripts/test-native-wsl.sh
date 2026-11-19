#!/usr/bin/env bash
# Native build and tests on Linux/GCC, configured like the CI native jobs in
# .github/workflows/build.yml. Meant for WSL with the sources on the Windows
# drive; the build tree stays on the Linux file system, which is much faster.
#
# Usage (from the repository root, in PowerShell or a WSL shell):
#   wsl -d Ubuntu-24.04 -- bash scripts/test-native-wsl.sh [ctest arguments]
#   e.g. ... -- bash scripts/test-native-wsl.sh -R necpp_periodic_green
#
# Environment:
#   NECPP_LINUX_BUILD_DIR   build tree (default: ~/necpp-build)
#   NECPP_SANITIZE=address  AddressSanitizer + UndefinedBehaviorSanitizer
#                           build, in "<build tree>-asan"
#   CATCH2_SOURCE_DIR       existing Catch2 v3.7.1 checkout to use instead of
#                           downloading it at configure time
set -euo pipefail

source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build_dir="${NECPP_LINUX_BUILD_DIR:-$HOME/necpp-build}"
configure=(
  -G Ninja
  -DCMAKE_BUILD_TYPE=Release
  -DBUILD_SHARED_LIBS=OFF
  -DNECPP_BUILD_TESTS=ON
  -DNECPP_BUILD_WASM=OFF
)

if [[ "${NECPP_SANITIZE:-}" == "address" ]]; then
  build_dir="${build_dir}-asan"
  sanitize="-fsanitize=address,undefined -fno-omit-frame-pointer -g"
  configure+=(
    "-DCMAKE_C_FLAGS=${sanitize}"
    "-DCMAKE_CXX_FLAGS=${sanitize}"
    "-DCMAKE_EXE_LINKER_FLAGS=-fsanitize=address,undefined"
  )
  export ASAN_OPTIONS="${ASAN_OPTIONS:-detect_leaks=0}"
  export UBSAN_OPTIONS="${UBSAN_OPTIONS:-print_stacktrace=1}"
elif [[ -n "${NECPP_SANITIZE:-}" ]]; then
  echo "NECPP_SANITIZE must be 'address' or unset" >&2
  exit 2
fi

if [[ -n "${CATCH2_SOURCE_DIR:-}" ]]; then
  configure+=("-DFETCHCONTENT_SOURCE_DIR_CATCH2=${CATCH2_SOURCE_DIR}")
fi

cmake -S "$source_dir" -B "$build_dir" "${configure[@]}"
cmake --build "$build_dir" --parallel "$(nproc)"
ctest --test-dir "$build_dir" --output-on-failure "$@"
