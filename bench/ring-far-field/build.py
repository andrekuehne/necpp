#!/usr/bin/env python3
"""Build an isolated harness. Production sources and artifacts are never written."""
import argparse
import concurrent.futures
import pathlib
import re
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--compiler', default='g++')
parser.add_argument('--out', required=True)
parser.add_argument('--wasm', action='store_true')
parser.add_argument('--jobs', type=int, default=2)
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[2]
out = pathlib.Path(args.out).resolve()
out.mkdir(parents=True, exist_ok=True)
(out / 'config.h').write_text(
    '#define NECPP_VERSION "2.5.0"\n'
    '#define NECPP_BUILD_DATE "ring-bench"\n')
source = (root / 'src/nec_context.cpp').read_text()
# Time exactly the two operations without changing the public interface or sources.
for statement, phase in [
    ('cmset( neq, cm, rkh );', 'fill'),
    ('factrs(m_output, npeq, neq, cm, ip );', 'factor'),
]:
    assert source.count(statement) == 1
    source = source.replace(statement,
        '{ const auto start = std::chrono::steady_clock::now(); ' + statement
        + ' ring_' + phase + '_ms = std::chrono::duration<double, std::milli>('
        'std::chrono::steady_clock::now()-start).count(); }')
(out / 'nec_context.cpp').write_text(
    '#include <chrono>\nextern double ring_fill_ms, ring_factor_ms;\n' + source)
names = re.search(r'set\(NECPP_LIB_SRCS(.*?)\)',
                  (root / 'src/CMakeLists.txt').read_text(), re.S)[1].split()
sources = [out / name if name == 'nec_context.cpp' else root / 'src' / name
           for name in names]
sources.append(root / 'bench/ring-far-field/bench.cpp')
# No fast math, SIMD, native-arch, or parallel solver. Match scalar release flags.
flags = [
    '-std=c++17', '-O3', '-DNDEBUG', '-fexceptions', '-flto',
    '-DNECPP_FAR_FIELD_CACHE_DIRECTIONS=1', '-DNECPP_FAR_FIELD_REUSE_OUTPUTS=1',
    '-I' + str(root / 'src'), '-I' + str(root / 'src/eigen'), '-I' + str(out),
]


def compile_source(path):
    obj = out / (path.stem + '.o')
    # Always compile: avoiding stale header/flag dependencies matters more than
    # incremental-build speed in a reproducibility harness.
    subprocess.run([args.compiler, *flags, '-c', str(path), '-o', str(obj)],
                   check=True)
    return str(obj)


with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
    objects = list(pool.map(compile_source, sources))
link = [
    '-sSTACK_SIZE=4194304', '-sALLOW_MEMORY_GROWTH=1', '-sENVIRONMENT=node',
    '-sDISABLE_EXCEPTION_CATCHING=0',
] if args.wasm else []
subprocess.run([args.compiler, *flags, *objects, *link, '-o',
                str(out / ('bench.js' if args.wasm else 'bench'))], check=True)
