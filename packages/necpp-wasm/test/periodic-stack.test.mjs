// Layered stacks above the infinite array (issue #32): a radome of dielectric
// layers acts on each Floquet mode through a TE and a TM reflection added to
// the matrix fill, and the modes above it are the waves it transmits.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { NecGeometryError, NecInputError, createNecPeriodicModel } from "../.test-build/src/index.js";
import { FREQUENCY_MHZ, RADIUS_M, WAVENUMBER_PER_M, entry, relativeMatrixError } from "./periodic-reference.mjs";

const hasWasm = existsSync(new URL("../.test-build/src/nec2pp.wasm", import.meta.url));
const skip = !hasWasm && "WASM artifacts have not been built";

const PERFECT = { kind: "perfect" };
const LATTICE = { a1M: [0.6, 0], a2M: [0, 0.5] };

/** A unit cell of straight wires, each fed at its centre segment, on LATTICE. */
async function wireCell(wires, { ground, segments = 11 } = {}) {
  const cell = await createNecPeriodicModel();
  wires.forEach(({ start, end }, index) => {
    cell.addWire({ tag: index + 1, segments, start, end, radiusM: RADIUS_M });
  });
  cell.completeGeometry();
  cell.definePorts(wires.map((_, index) => ({ tag: index + 1, segment: (segments + 1) / 2 })));
  if (ground !== undefined) cell.setGround(ground);
  cell.setLattice(LATTICE);
  return cell;
}

const X_DIPOLE = { start: [-0.24, 0, 0.25], end: [0.24, 0, 0.25] };
const TILTED = { start: [-0.2, 0.15, 0.12], end: [0.2, 0.25, 0.36] };

/** Largest difference of the per-port amplitudes of matching modes, relative to the largest amplitude. */
function amplitudeError(floquet, reference) {
  let scale = 0;
  let error = 0;
  assert.equal(floquet.modes.length, reference.modes.length);
  reference.modes.forEach((mode, index) => {
    const other = floquet.modes[index];
    assert.deepEqual([other.p, other.q, other.side], [mode.p, mode.q, mode.side]);
    for (const part of ["te", "tm"]) {
      for (let port = 0; port < mode[part].real.length; port += 1) {
        scale = Math.max(scale, Math.hypot(mode[part].real[port], mode[part].imag[port]));
        error = Math.max(error, Math.hypot(
          other[part].real[port] - mode[part].real[port],
          other[part].imag[port] - mode[part].imag[port],
        ));
      }
    }
  });
  return error / scale;
}

test("a layer of relative permittivity 1 changes nothing", { skip, timeout: 120_000 }, async () => {
  for (const ground of [undefined, PERFECT]) {
    const cell = await wireCell([X_DIPOLE, TILTED], { ground });
    try {
      const request = { frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0.8, -0.6], evanescentModes: [{ p: 1, q: 0 }] };
      const bare = cell.computeScanImpedance(request);
      cell.setLayeredStacks({ above: { bottomZM: 0.5, layers: [{ thicknessM: 0.1, relativePermittivity: 1 }] } });
      const covered = cell.computeScanImpedance(request);
      assert.ok(relativeMatrixError(covered.impedance, bare.impedance) < 1e-12);
      assert.ok(amplitudeError(covered.floquet, bare.floquet) < 1e-12, `amplitudes, ground ${ground?.kind}`);
      for (const power of covered.floquet.powerBudget) assert.ok(Math.abs(power.dielectricLossW) < 1e-15);
      // The gap is from the highest point of a wire (the tilted one, 0.36 m) to the stack.
      assert.ok(Math.abs(covered.diagnostics.layeredStack.gapM - 0.14) < 1e-12);
      assert.ok(covered.diagnostics.layeredStack.modeCount > 0);
      assert.equal(bare.diagnostics.layeredStack, undefined);

      cell.setLayeredStacks({});
      assert.ok(relativeMatrixError(cell.computeScanImpedance(request).impedance, bare.impedance) === 0);
    } finally {
      cell.dispose();
    }
  }
});

const mirrored = (height) => ({ start, end }) => ({
  start: [start[0], start[1], height - start[2]],
  end: [end[0], end[1], height - end[2]],
});

test("a highly conducting layer acts as a ground plane at its lower face", { skip, timeout: 120_000 }, async () => {
  // An independent route: a ground plane at z = H above a free-space cell is
  // the perfect ground of the mirrored cell (z -> H - z), solved by images.
  // A layer of loss tangent 1e12 reflects as -1 to about 1e-6.
  const height = 0.6;
  const wires = [X_DIPOLE, TILTED];
  for (const scanPhasesRad of [[0, 0], [0.8, -0.6], [2.6, 0.4]]) {
    const request = { frequencyMHz: FREQUENCY_MHZ, scanPhasesRad };
    const covered = await wireCell(wires);
    const grounded = await wireCell(wires.map(mirrored(height)), { ground: PERFECT });
    try {
      covered.setLayeredStacks({
        above: { bottomZM: height, layers: [{ thicknessM: 0.05, relativePermittivity: 1, lossTangent: 1e12 }] },
      });
      const stack = covered.computeScanImpedance(request);
      const image = grounded.computeScanImpedance(request);
      const error = relativeMatrixError(stack.impedance, image.impedance);
      assert.ok(error < 1e-5, `scan phases ${scanPhasesRad}: ${error}`);
      // What the cell radiates downwards is what the mirrored cell radiates upwards.
      stack.floquet.powerBudget.forEach((power, port) => {
        const mirror = image.floquet.powerBudget[port];
        assert.ok(Math.abs(power.propagatingW - mirror.propagatingW) < 1e-5 * mirror.inputW);
        assert.ok(power.dielectricLossW >= 0 && power.dielectricLossW < 1e-4 * power.inputW);
      });
    } finally {
      covered.dispose();
      grounded.dispose();
    }
  }
});

test("a thinning layer approaches the bare array", { skip, timeout: 120_000 }, async () => {
  const cell = await wireCell([X_DIPOLE]);
  try {
    const request = { frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0.8, -0.6] };
    const bare = cell.computeScanImpedance(request);
    const changes = [1e-2, 1e-3, 1e-4].map((thicknessM) => {
      cell.setLayeredStacks({ above: { bottomZM: 0.4, layers: [{ thicknessM, relativePermittivity: 6, lossTangent: 0.02 }] } });
      const covered = cell.computeScanImpedance(request);
      return {
        impedance: relativeMatrixError(covered.impedance, bare.impedance),
        amplitudes: amplitudeError(covered.floquet, bare.floquet),
        loss: covered.floquet.powerBudget[0].dielectricLossW / covered.floquet.powerBudget[0].inputW,
      };
    });
    // First order in the thickness: each tenth of it leaves a tenth of the
    // change in the scan impedance, the amplitudes and the loss.
    assert.ok(changes[0].impedance > 1e-3, JSON.stringify(changes));
    for (const quantity of ["impedance", "amplitudes", "loss"]) {
      for (let index = 1; index < changes.length; index += 1) {
        const ratio = changes[index][quantity] / changes[index - 1][quantity];
        assert.ok(ratio > 0.07 && ratio < 0.13, `${quantity}: ${JSON.stringify(changes)}`);
      }
    }
  } finally {
    cell.dispose();
  }
});

test("power closes including the loss in a lossy stack", { skip, timeout: 120_000 }, async () => {
  // Port input power returns as transmitted and downward Floquet power plus
  // the stack's loss. A sheet close to the wires absorbs much of its loss
  // from evanescent modes. 21 segments: the moment method's own power error
  // is about 1e-3 (issue #29).
  const stacks = [
    { bottomZM: 0.45, layers: [{ thicknessM: 0.05, relativePermittivity: 4, lossTangent: 0.3 }] },
    { bottomZM: 0.3, layers: [{ thicknessM: 0.01, relativePermittivity: 10, lossTangent: 0.5 },
      { thicknessM: 0.03, relativePermittivity: 2.2, lossTangent: 0.02 }] },
  ];
  for (const ground of [undefined, PERFECT]) {
    for (const above of stacks) {
      const cell = await wireCell([X_DIPOLE], { ground, segments: 21 });
      try {
        cell.setLayeredStacks({ above });
        for (const scanPhasesRad of [[0, 0], [1.5, 0], [0, 1.2]]) {
          const result = cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad });
          const [power] = result.floquet.powerBudget;
          const returned = power.propagatingW + power.lossW + power.dielectricLossW;
          const label = `ground ${ground?.kind}, stack at ${above.bottomZM}, scan ${scanPhasesRad}: ${JSON.stringify(power)}`;
          assert.ok(power.dielectricLossW > 0.05 * power.inputW, label);
          assert.ok(Math.abs(returned - power.inputW) < 2e-3 * power.inputW, label);
        }
      } finally {
        cell.dispose();
      }
    }
  }
});

/** The (0, 0) mode's amplitudes on one side, per port. */
function broadsideMode(result, side = "above") {
  return result.floquet.modes.find((mode) => mode.p === 0 && mode.q === 0 && mode.side === side);
}

/** Largest |a - factor b| over the te and tm amplitudes of two modes, relative to the largest |b|. */
function scaledAmplitudeError(mode, reference, [fr, fi]) {
  let scale = 0;
  let error = 0;
  for (const part of ["te", "tm"]) {
    for (let port = 0; port < reference[part].real.length; port += 1) {
      const [br, bi] = [reference[part].real[port], reference[part].imag[port]];
      scale = Math.max(scale, Math.hypot(br, bi));
      error = Math.max(error, Math.hypot(mode[part].real[port] - (fr * br - fi * bi), mode[part].imag[port] - (fr * bi + fi * br)));
    }
  }
  return error / scale;
}

test("the modes above a stack are the transmitted waves, with the slab's phase", { skip, timeout: 120_000 }, async () => {
  // Far above the wires (evanescent reflections below 1e-7) the stack acts
  // on the cell only through the (0, 0) mode. Where that mode crosses
  // without reflection, the cell's current is that of the bare array, and
  // the wave above is the bare one times the slab's own transmission,
  // referred back to the origin: T exp(j kz d).
  const k = WAVENUMBER_PER_M;
  // A half-wave window at broadside (TE and TM): T = -1.
  {
    const thicknessM = Math.PI / (2 * k);  // half a wavelength in eps_r 4
    const cell = await wireCell([TILTED]);
    try {
      const request = { frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0, 0] };
      const bare = cell.computeScanImpedance(request);
      cell.setLayeredStacks({ above: { bottomZM: 1.5, layers: [{ thicknessM, relativePermittivity: 4 }] } });
      const covered = cell.computeScanImpedance(request);
      const phase = k * thicknessM;
      const expected = [-Math.cos(phase), -Math.sin(phase)];
      assert.ok(scaledAmplitudeError(broadsideMode(covered), broadsideMode(bare), expected) < 1e-5);
      assert.ok(scaledAmplitudeError(broadsideMode(covered, "below"), broadsideMode(bare, "below"), [1, 0]) < 1e-5);
      assert.ok(relativeMatrixError(covered.impedance, bare.impedance) < 1e-5);
    } finally {
      cell.dispose();
    }
  }
  // TM at the Brewster angle of eps_r 3 (60 degrees, E-plane, where an
  // x-dipole radiates TM only): T = exp(-j kz1 d), kz1 = k sqrt(3 - 3/4).
  {
    const thicknessM = 0.13;
    const cell = await createNecPeriodicModel();
    try {
      cell.addWire({ tag: 1, segments: 11, start: X_DIPOLE.start, end: X_DIPOLE.end, radiusM: RADIUS_M });
      cell.completeGeometry();
      cell.definePorts([{ tag: 1, segment: 6 }]);
      // 0.5 m along the scan plane: no grating lobe at 60 degrees.
      cell.setLattice({ a1M: [0.5, 0], a2M: [0, 0.5] });
      const request = { frequencyMHz: FREQUENCY_MHZ, scanDirection: { thetaDeg: 60, phiDeg: 0 } };
      const bare = cell.computeScanImpedance(request);
      cell.setLayeredStacks({ above: { bottomZM: 2.75, layers: [{ thicknessM, relativePermittivity: 3 }] } });
      const covered = cell.computeScanImpedance(request);
      const phase = k * (0.5 - 1.5) * thicknessM;  // kz d - kz1 d
      assert.ok(scaledAmplitudeError(broadsideMode(covered), broadsideMode(bare), [Math.cos(phase), Math.sin(phase)]) < 1e-5);
    } finally {
      cell.dispose();
    }
  }
});

const RADOME = { bottomZM: 0.45, layers: [{ thicknessM: 0.05, relativePermittivity: 4, lossTangent: 0.02 }] };

test("the stack's terms are reciprocal: dZ(psi) = dZ(-psi)^T", { skip, timeout: 120_000 }, async () => {
  // The bare solver is reciprocal only to its point-matching error (6e-4
  // here, 11 segments), so the test takes the stack's change of the scan
  // impedance, measured reciprocal to 1.3e-4 of its largest entry.
  for (const ground of [undefined, PERFECT]) {
    const cell = await wireCell([X_DIPOLE, TILTED], { ground });
    try {
      const change = (scanPhasesRad) => {
        cell.setLayeredStacks({});
        const bare = cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad }).impedance;
        cell.setLayeredStacks({ above: RADOME });
        const covered = cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad }).impedance;
        const minus = (part) => covered[part].map((value, index) => value - bare[part][index]);
        return { rows: 2, columns: 2, real: minus("real"), imag: minus("imag") };
      };
      const forward = change([1.1, -0.7]);
      const backward = change([-1.1, 0.7]);
      const transpose = (part) => Float64Array.from([0, 2, 1, 3], (index) => backward[part][index]);
      const error = relativeMatrixError(forward, { ...backward, real: transpose("real"), imag: transpose("imag") });
      assert.ok(error < 1e-3, `ground ${ground?.kind}: ${error}`);
    } finally {
      cell.dispose();
    }
  }
});

test("a stack is refused when a wire enters it or the gap is too small", { skip, timeout: 120_000 }, async () => {
  const cell = await wireCell([X_DIPOLE, TILTED]);
  try {
    const layers = RADOME.layers;
    // The tilted wire reaches z = 0.36 at its axis, 0.361 with its radius.
    assert.throws(() => cell.setLayeredStacks({ above: { bottomZM: 0.3605, layers } }), (error) =>
      error instanceof NecGeometryError && /ENTERS THE LAYERED STACK/.test(error.message)
        && /TAG 2/.test(error.message));
    // Refused without effect: the cell still solves bare.
    cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0, 0] });

    cell.setLayeredStacks({ above: { bottomZM: 0.362, layers } });
    assert.throws(() => cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0, 0] }), (error) =>
      error instanceof NecGeometryError && /TOO CLOSE TO THE WIRES/.test(error.message)
        && /GAP OF 0\.002 M/.test(error.message) && /NEEDS ABOUT \d+ FLOQUET MODES/.test(error.message));

    for (const stacks of [
      { above: { bottomZM: 0.5, layers: [] } },
      { above: { bottomZM: 0.5, layers: [{ thicknessM: 0, relativePermittivity: 4 }] } },
      { above: { bottomZM: 0.5, layers: [{ thicknessM: 0.1, relativePermittivity: 0.5 }] } },
      { above: { bottomZM: 0.5, layers: [{ thicknessM: 0.1, relativePermittivity: 4, lossTangent: -0.1 }] } },
      { above: { bottomZM: Number.NaN, layers } },
      { below: { bottomZM: -0.5, layers } },
    ]) {
      assert.throws(() => cell.setLayeredStacks(stacks), NecInputError, JSON.stringify(stacks));
    }
  } finally {
    cell.dispose();
  }
});

test("sweep workers replay the stack", { skip, timeout: 120_000 }, async () => {
  const cell = await wireCell([X_DIPOLE, TILTED]);
  try {
    cell.setLayeredStacks({ above: RADOME });
    const scanStates = [{ scanPhasesRad: [0.3, 0.2] }, { scanDirection: { thetaDeg: 40, phiDeg: 30 } }];
    const swept = [];
    for await (const chunk of cell.sweepScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanStates }, { workers: 2 })) {
      swept.push(...chunk.points);
    }
    for (const { index, result } of swept) {
      const direct = cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, ...scanStates[index] });
      assert.ok(relativeMatrixError(result.impedance, direct.impedance) < 1e-12);
      assert.deepEqual(result.diagnostics, direct.diagnostics);
      assert.equal(result.floquet.powerBudget[0].dielectricLossW, direct.floquet.powerBudget[0].dielectricLossW);
    }

    // The scan element pattern's sweep runs on the same workers: at a sample
    // it is exactly the transmitted (0, 0) amplitude.
    const pattern = await cell.computeScanElementPattern(
      { frequencyMHz: FREQUENCY_MHZ, grid: { spacingUV: 0.5 }, refinement: false },
      { workers: 2 },
    );
    const sample = pattern.samples.find(({ u, v }) => Math.hypot(u, v) > 0.2 && Math.hypot(u, v) < 0.8);
    const direct = broadsideMode(cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: sample.scanPhasesRad }));
    const value = pattern.evaluate({ u: sample.u, v: sample.v });
    assert.equal(value.sampled, true);
    for (let port = 0; port < 2; port += 1) {
      assert.equal(value.te.real[port], direct.te.real[port]);
      assert.equal(value.tm.imag[port], direct.tm.imag[port]);
    }
  } finally {
    cell.dispose();
  }
});

test("with a stack, the scan impedance is finite and continuous through a Wood anomaly", { skip, timeout: 300_000 }, async () => {
  // The (1, 0) mode reaches cut-off near psi1 = 2.5 (0.6 m cells). Bisect on
  // the engine's own kz of that mode down to floating-point resolution, from
  // both sides; the stack's terms nearly cancel the kernel's split singular
  // part there.
  for (const [ground, above] of [
    [undefined, RADOME],
    [PERFECT, RADOME],
    // Lossless and thin: nearly transparent at grazing, as an eps = 1 layer.
    [undefined, { bottomZM: 0.45, layers: [{ thicknessM: 0.001, relativePermittivity: 2 }] }],
  ]) {
    const cell = await wireCell([TILTED], { ground });
    try {
      cell.setLayeredStacks({ above });
      const solve = (psi1) => cell.computeScanImpedance({
        frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [psi1, 0.3], evanescentModes: [{ p: 1, q: 0 }],
      });
      const kz = (result) => result.floquet.modes.find((mode) => mode.p === 1 && mode.q === 0 && mode.side === "above").kzRadPerM;
      let [evanescent, propagating] = [2.3, 2.7];
      for (let step = 0; step < 60 && propagating - evanescent > 1e-15; step += 1) {
        const middle = (evanescent + propagating) / 2;
        if (middle === evanescent || middle === propagating) break;
        if (kz(solve(middle))[1] < 0) evanescent = middle;
        else propagating = middle;
      }
      const results = [evanescent, propagating].map(solve);
      const label = `ground ${ground?.kind}, stack ${JSON.stringify(above.layers)}`;
      for (const result of results) {
        assert.equal(result.diagnostics.status, "near-cutoff", label);
        assert.ok(Math.hypot(...kz(result)) < 1e-6, `${label}: kz ${kz(result)}`);
        assert.ok(result.diagnostics.estimatedError < 1e-5, label);
        assert.ok(entry(result.impedance, 0, 0).every(Number.isFinite), label);
      }
      // Both sides of the anomaly meet to the periodic tolerance (measured
      // 1e-7 to 1.3e-6, as without a stack: the square-root kink over the
      // last floating-point step, |kz| / k = 1.4e-8), and a state nearby is
      // close.
      assert.ok(relativeMatrixError(results[0].impedance, results[1].impedance) < 1e-5, label);
      const nearby = solve(propagating + 1e-10);
      const error = relativeMatrixError(nearby.impedance, results[1].impedance);
      assert.ok(error < 1e-3, `${label}: ${error}`);
    } finally {
      cell.dispose();
    }
  }
});

test("a spaced lossy sheet over a strip-dipole array matches a full-wave FEM unit cell", { skip, timeout: 300_000 }, async () => {
  // Reference: CST Studio Suite 2024 frequency-domain unit-cell simulation
  // (Floquet port, second-order tetrahedra, adaptive mesh), run for issue #32
  // from the spec in test/fixtures/fem-issue32/README.md; values in
  // fem-issue32-results.csv (final mesh pass; the previous pass is within
  // 0.2 ohm with the sheet, 0.7 ohm without). 48 x 2 mm PEC strips 25 mm
  // over ground on a 60 x 50 mm lattice at 2.998 GHz, a 3 mm sheet of eps_r 4,
  // tan delta 0.02 from z = 40 mm (case A), and the bare array (case B).
  // necpp models the strip as a wire of radius w / 4 = 0.5 mm, 21 segments
  // (4.6 radii each); the feed differs (a 1 mm face port against a segment
  // source), which shifts both cases by about 5 ohm, so the sheet's effect is
  // compared as Z_A - Z_B. Measured: the transmitted (0,0) power fractions and
  // the sheet loss within 3.3e-4 of CST's (whose own power balance closes to
  // 3e-4), Z_A - Z_B within 3.0 to 4.3 % of CST's.
  const rows = readFileSync(new URL("./fixtures/fem-issue32/fem-issue32-results.csv", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("case"))
    .map((line) => line.split(","))
    .filter((fields) => fields[3] === "final")
    .map(([kase, phiDeg, thetaDeg, , r, x, te, tm, loss]) => ({
      kase, phiDeg: Number(phiDeg), thetaDeg: Number(thetaDeg), z: [Number(r), Number(x)],
      te: Number(te), tm: Number(tm), loss: Number(loss),
    }));
  assert.equal(rows.length, 16);
  const sheet = { bottomZM: 0.04, layers: [{ thicknessM: 0.003, relativePermittivity: 4, lossTangent: 0.02 }] };
  const cells = {};
  for (const kase of ["A", "B"]) {
    const cell = await createNecPeriodicModel();
    cell.addWire({ tag: 1, segments: 21, start: [-0.024, 0, 0.025], end: [0.024, 0, 0.025], radiusM: 0.0005 });
    cell.completeGeometry();
    cell.definePorts([{ tag: 1, segment: 11 }]);
    cell.setGround(PERFECT);
    cell.setLattice({ a1M: [0.06, 0], a2M: [0, 0.05] });
    if (kase === "A") cell.setLayeredStacks({ above: sheet });
    cells[kase] = cell;
  }
  try {
    const solved = new Map();
    for (const row of rows) {
      const result = cells[row.kase].computeScanImpedance({
        frequencyMHz: 2997.92458,
        scanDirection: { thetaDeg: row.thetaDeg, phiDeg: row.phiDeg },
      });
      solved.set(`${row.kase} ${row.phiDeg} ${row.thetaDeg}`, result);
      if (row.kase !== "A") continue;
      const label = `phi ${row.phiDeg}, theta ${row.thetaDeg}`;
      const [power] = result.floquet.powerBudget;
      const broadside = result.floquet.modes.find((mode) => mode.p === 0 && mode.q === 0 && mode.side === "above");
      const fraction = ({ real, imag }) => (real[0] ** 2 + imag[0] ** 2) / 2 / power.inputW;
      assert.ok(Math.abs(fraction(broadside.te) - row.te) < 1e-3, `${label}: TE ${fraction(broadside.te)} vs ${row.te}`);
      assert.ok(Math.abs(fraction(broadside.tm) - row.tm) < 1e-3, `${label}: TM ${fraction(broadside.tm)} vs ${row.tm}`);
      const loss = power.dielectricLossW / power.inputW;
      assert.ok(Math.abs(loss - row.loss) < 5e-4, `${label}: sheet loss ${loss} vs ${row.loss}`);
    }
    for (const row of rows.filter(({ kase }) => kase === "A")) {
      const bare = rows.find(({ kase, phiDeg, thetaDeg }) => kase === "B" && phiDeg === row.phiDeg && thetaDeg === row.thetaDeg);
      const z = (kase) => entry(solved.get(`${kase} ${row.phiDeg} ${row.thetaDeg}`).impedance, 0, 0);
      const [za, zb] = [z("A"), z("B")];
      const change = [za[0] - zb[0], za[1] - zb[1]];
      const reference = [row.z[0] - bare.z[0], row.z[1] - bare.z[1]];
      const error = Math.hypot(change[0] - reference[0], change[1] - reference[1]) / Math.hypot(...reference);
      assert.ok(error < 0.06, `phi ${row.phiDeg}, theta ${row.thetaDeg}: sheet changes Z by ${change}, FEM ${reference}`);
    }
  } finally {
    cells.A.dispose();
    cells.B.dispose();
  }
});
