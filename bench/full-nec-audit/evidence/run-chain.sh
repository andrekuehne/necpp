#!/bin/bash
cd /home/user/necpp/packages/necpp-wasm
A=/home/user/build/audit
# 1. remaining scalar cases
node bench/full-nec-audit.mjs --module-directory /home/user/build/dist-scalar --output $A/scalar.ndjson --label scalar --only '^(?!dipole-sunflower-64-perfect$).*' >> $A/scalar.log 2>&1
# 2. simd128 subset
node bench/full-nec-audit.mjs --module-directory /home/user/build/dist-simd --output $A/simd.ndjson --label simd --only '^(dipole-sunflower-(64|128|256)-perfect|crossed-sunflower-136-perfect|helix-sunflower-32-perfect)$' > $A/simd.log 2>&1
# 3. probe (scalar + internal stage split) subset
node bench/full-nec-audit.mjs --module-directory /home/user/build/dist-probe --output $A/probe.ndjson --label probe --only '^(dipole-sunflower-(64|128|256)-perfect|dipole-sunflower-256-free|crossed-sunflower-136-perfect|helix-sunflower-32-perfect)$' > $A/probe.log 2>&1
# 4. serial field path (fieldWorkers=1) for the worker-overhead comparison
node bench/full-nec-audit.mjs --module-directory /home/user/build/dist-scalar --output $A/serial.ndjson --label serial --field-workers 1 --only '^(dipole-sunflower-(64|256)-perfect)$' > $A/serial.log 2>&1
echo CHAIN-DONE
