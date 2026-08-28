# WP6 Web Worker entry point

WP6 adds an optional worker facade so browser applications can keep realistic
NEC solves off the UI thread. The public factory is
`createNecWorkerModel()` from the `@necpp-engine/wasm/worker` subpath. Direct
`createNecModel()` remains the Node, test, and small-model entry point.

The package ships the worker script. Consumers import the documented subpath
and do not author a bootstrap file, `locateFile` helper, or Emscripten glue.

## Lifecycle and messaging

Each worker model owns one dedicated worker and one isolated Emscripten
module. The native `NecModel` stays inside the worker for the lifetime of the
client object. Requests are serialized per model: a second method call waits
until the previous reply arrives. Two `createNecWorkerModel()` calls create
two workers and do not share handles, heaps, or factorization state.

Worker methods are asynchronous and otherwise match `NecModel`. Returned typed
arrays are reconstructed on the client from transferred `ArrayBuffer`s, so
they remain valid after later solves, WASM growth, or disposal. Input arrays
are copied before posting; the caller's buffers are never detached.

Coarse `start`/`complete` progress events are posted at operation boundaries,
including worker-only `create`. Listeners run on the client thread.

## Cancellation

An in-progress native solve is not interruptible. `terminate()` kills the
worker immediately, rejects every outstanding promise with `NecRuntimeError`,
and leaves `state === "disposed"`. `dispose()` asks the worker to destroy the
native handle, then terminates the thread. Both are idempotent.

## Verification

Node tests cover transferable result buffers, serialized per-model queues,
client-thread heartbeats during outstanding work, independent models, error
revival, and termination. When WASM artifacts are present, a real
`worker_threads` integration compares Z matrices and far fields with direct
mode at the native-to-WASM bulk tolerance of `1e-12`.
