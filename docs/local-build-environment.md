# Local build environment notes

Last verified on 2026-08-28. These notes describe the current Windows
workstation and its existing build trees. Paths under the user's temporary
directory are machine-specific and may disappear after cleanup or reboot.

## Host environment

- Repository: `C:\Users\andre\VSCode_Projects\necpp`
- Shell: Windows PowerShell 5.1.26100.9168
- Docker: 29.7.2
- Visual Studio: 2022 Community
- MSBuild: 17.14.51.32402
- MSVC compiler: 19.44.35228.0, x64
- Project C++ standard: C++17

This PowerShell does not accept `&&` as a statement separator. Run host
commands on separate lines and check `$LASTEXITCODE` when the second command
must not run after a failure. `&&` is still valid inside a quoted `sh -lc`
command executed by Docker.

## Existing Windows/MSVC build

`build-wp0` is the usable host build tree. Despite its historical name, it is
regenerated from the current source and contains the WP1 through WP4 test
partitions. Its relevant configuration is:

- generator: `Visual Studio 17 2022`
- platform: `x64`
- configuration used for testing: `Release`
- compiler:
  `C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64\cl.exe`
- MSBuild:
  `C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe`

`cmake` and `ctest` are not on the PowerShell `PATH`. The existing build cache
currently points to CMake/CTest 3.31.6 here:

```powershell
$CMakeTools = "C:\Users\andre\AppData\Local\Temp\codex-necpp-cmake\cmake\data\bin"
```

Because this is a temporary path, inspect `build-wp0\CMakeCache.txt` entries
`CMAKE_COMMAND` and `CMAKE_CTEST_COMMAND` if it stops working. Installing CMake
normally and adding it to `PATH` is the durable alternative.

Build the native test runner:

```powershell
& "$CMakeTools\cmake.exe" --build "build-wp0" `
    --config Release --target "nec2++_tests" --parallel
```

Direct MSBuild is a fallback:

```powershell
& "C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe" `
    "build-wp0\tests\nec2++_tests.vcxproj" `
    /p:Configuration=Release /p:Platform=x64 /m
```

When `tests\CMakeLists.txt` adds a new source, the first direct MSBuild
invocation may only regenerate the Visual Studio project while continuing with
the project definition it loaded at startup. Run the build a second time and
confirm the new source appears in the compiler output.

Run all registered tests:

```powershell
& "$CMakeTools\ctest.exe" --test-dir "build-wp0" `
    -C Release --output-on-failure -j1
```

Run one Catch2 work-package partition directly:

```powershell
& "build-wp0\tests\Release\nec2++_tests.exe" "[wp4]"
```

Registered CTest entries are `necpp_unit`, `necpp_wp1`, `necpp_wp2`,
`necpp_wp3`, `necpp_wp4`, and `necpp_smoke_hertzian_dipole`. The test binary is compiled
with `NEC_ERROR_CHECK=1`, so direct runs can emit substantial solver tracing.

## Docker native build

The locally available `emscripten/emsdk:4.0.7` image also contains:

- CMake 3.22.1
- Ubuntu g++ 11.4.0

It can provide a clean Linux/GCC cross-check without installing host CMake.
Explicitly select `g++`; otherwise the Emscripten image is intended primarily
for `emcc`/`em++`.

The current Linux build tree is `build-wp3-linux`. It is a Release,
static-library, non-LTO build configured with container path `/src`:

```powershell
docker run --rm -v "${PWD}:/src" -w /src `
    emscripten/emsdk:4.0.7 sh -lc `
    "cmake -S . -B build-wp3-linux `
      -DNECPP_BUILD_TESTS=ON `
      -DBUILD_SHARED_LIBS=OFF `
      -DNECPP_ENABLE_LTO=OFF `
      -DCMAKE_BUILD_TYPE=Release `
      -DCMAKE_CXX_COMPILER=g++ &&
     cmake --build build-wp3-linux -j2 &&
     ctest --test-dir build-wp3-linux --output-on-failure -j1"
```

The first configure downloads Catch2 v3.7.1, so a fresh build needs network
access. Build directories matching `build-*` are ignored by Git.

## WASM build

Use the repository's pinned PowerShell wrapper rather than reconstructing the
Emscripten flags manually:

```powershell
.\scripts\build_wasm_docker.ps1
```

It uses `emscripten/emsdk:4.0.7`, TypeScript 5.8.3, and a container-local build
directory under `/tmp`. Building on the container filesystem is intentional:
Emscripten link steps can fail when writing intermediate files directly to a
Windows bind mount. Successful artifacts are copied to:

```text
wasm/nec2pp.js
wasm/nec2pp.wasm
wasm/nec2pp.d.ts
```

The wrapper runs `scripts/wasm_smoke_test.mjs`, stages the generated loader and
binary beside the handwritten TypeScript facade, and runs the strict facade
and Node ESM integration tests. Generated WASM artifacts, the facade's
`.test-build` directory, and all `build-*` directories are ignored by Git.

## Known-good verification

The WP5 implementation was verified with:

- Windows/MSVC: all six CTest entries passed, including the CLI smoke test;
- focused WP4: the C caller contract and native bulk-buffer comparison passed;
- Linux/GCC in Docker: all six CTest entries passed;
- both native production executables, `nec2++` and `nec2diff`, built
  successfully in the Docker Release build;
- Emscripten 4.0.7: the versioned ABI matrix, solve, combined/embedded field,
  memory-growth, controlled-error, and complete-deck smoke paths passed.
- TypeScript 5.8.3 and Node ESM: the public facade passed strict compilation,
  real matrix/solve/field operations, copied-result lifetime and disposal
  checks, default/URL/binary WASM loading, and complete-deck execution.

The WP6 worker facade was verified on the same host with TypeScript 5.8.3 and
Node ESM: all 24 package tests passed, including transferable result buffers,
client-thread heartbeats during outstanding work, independent worker models,
termination, and real WASM Z-matrix/far-field agreement with direct mode.
