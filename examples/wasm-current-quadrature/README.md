# Isolated-element current quadrature examples

These two standalone examples characterize one dipole at 300 MHz and obtain
isolated Z/Y plus packed NECQ currents and NECF embedded fields:

- `manual-direct.mjs` uses the synchronous model after asynchronous creation.
- `manual-worker-handoff.mjs` uses the package worker and transfers the large
  buffers onto a mock consumer `MessagePort`. The client keeps Z/Y and byte
  lengths only. A follow-up steer must not re-transfer the packed planes.

From this directory, install `@necpp-engine/wasm` and run either file with
Node 24 or newer. Release tests copy both files into a clean consumer and
install the exact candidate tarball.

Do not put NECQ or NECF buffers in UI or React state. Bind them once in a
compute worker.
