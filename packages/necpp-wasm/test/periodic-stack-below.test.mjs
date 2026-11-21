// Layered stacks below the infinite array and finite ground (issue #33): a
// substrate, or soil of finite conductivity, acts on each Floquet mode through
// a TE and a TM reflection added to the matrix fill, as the radome above does.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { NecGeometryError, NecInputError, createNecModel, createNecPeriodicModel } from "../.test-build/src/index.js";
import {
  FEED_SEGMENT,
  FREQUENCY_MHZ,
  RADIUS_M,
  WAVENUMBER_PER_M,
  dipoleWire,
  distance,
  entry,
  finiteArrayCentreImpedance,
  magnitude,
  relativeMatrixError,
} from "./periodic-reference.mjs";

const hasWasm = existsSync(new URL("../.test-build/src/nec2pp.wasm", import.meta.url));
const skip = !hasWasm && "WASM artifacts have not been built";

const PERFECT = { kind: "perfect" };
const soil = (relativePermittivity, conductivitySPerM, method = "reflection-coefficient") =>
  ({ kind: "finite", method, relativePermittivity, conductivitySPerM });
const LATTICE = { a1M: [0.6, 0], a2M: [0, 0.5] };

/** A unit cell of straight wires, each fed at its centre segment. */
async function wireCell(wires, { ground, segments = 11, lattice = LATTICE } = {}) {
  const cell = await createNecPeriodicModel();
  wires.forEach(({ start, end }, index) => {
    cell.addWire({ tag: index + 1, segments, start, end, radiusM: RADIUS_M });
  });
  cell.completeGeometry();
  cell.definePorts(wires.map((_, index) => ({ tag: index + 1, segment: (segments + 1) / 2 })));
  if (ground !== undefined) cell.setGround(ground);
  cell.setLattice(lattice);
  return cell;
}

const X_DIPOLE = { start: [-0.24, 0, 0.25], end: [0.24, 0, 0.25] };
const TILTED = { start: [-0.2, 0.15, 0.12], end: [0.2, 0.25, 0.36] };

test("finite ground of very high conductivity acts as perfect ground, also under a radome", {
  skip,
  timeout: 120_000,
}, async () => {
  // An independent route: perfect ground is solved by images in the kernel,
  // finite ground through each mode's Fresnel reflection. Measured 1.2e-5 to
  // 4.8e-5 at 1e8 S/m, falling as 1 / sqrt(sigma) (1.2e-4 to 4.8e-4 at 1e6).
  // Under the radome the soil and the radome reflect between each other.
  const wires = [X_DIPOLE, TILTED];
  for (const [above, scanPhasesRad] of [
    [undefined, [0, 0]], [undefined, [0.8, -0.6]], [undefined, [2.6, 0.4]], [RADOME, [0.8, -0.6]],
  ]) {
    const request = { frequencyMHz: FREQUENCY_MHZ, scanPhasesRad };
    const finite = await wireCell(wires, { ground: soil(1, 1e8) });
    const perfect = await wireCell(wires, { ground: PERFECT });
    try {
      if (above) {
        finite.setLayeredStacks({ above });
        perfect.setLayeredStacks({ above });
      }
      const reflected = finite.computeScanImpedance(request);
      const imaged = perfect.computeScanImpedance(request);
      const error = relativeMatrixError(reflected.impedance, imaged.impedance);
      assert.ok(error < 1e-4, `radome ${Boolean(above)}, scan phases ${scanPhasesRad}: ${error}`);
      // Nothing radiates below the ground, and the soil takes almost nothing.
      assert.equal(reflected.floquet.modes.some((mode) => mode.side === "below"), false);
      reflected.floquet.powerBudget.forEach((power, port) => {
        assert.ok(Math.abs(power.propagatingW - imaged.floquet.powerBudget[port].propagatingW) < 1e-4 * power.inputW);
        const radomeLoss = above ? imaged.floquet.powerBudget[port].dielectricLossW : 0;
        assert.ok(Math.abs(power.dielectricLossW - radomeLoss) < 1e-3 * power.inputW);
      });
      // The gap is from the lowest point of a wire axis (the tilted one, 0.12 m)
      // to the ground, or the smaller one up to the radome (0.36 m to 0.45 m).
      assert.ok(Math.abs(reflected.diagnostics.layeredStack.gapM - (above ? 0.09 : 0.12)) < 1e-12);
      if (!above) assert.equal(imaged.diagnostics.layeredStack, undefined);
    } finally {
      finite.dispose();
      perfect.dispose();
    }
  }
});

test("over finite ground, very large lattice spacing approaches NEC's reflection-coefficient ground", {
  skip,
  timeout: 300_000,
}, async () => {
  // A half-wave dipole half a wavelength over soil (eps_r 13, 0.005 S/m),
  // where the reflection-coefficient approximation of the isolated element
  // is good. As in free space, squared spacings (in wavelengths) between
  // sums of two squares keep every Floquet mode away from cut-off. Measured
  // 24 %, 3.7 % and 0.45 %; the ground damps the coupling along it, which in
  // free space still leaves 6.3 % at the largest spacing (a larger cell is
  // refused). The isolated element over Sommerfeld-Norton ground differs by
  // 1.3 %, which this limit cannot resolve; the finite array below can.
  const height = 0.5;
  const ground = soil(13, 0.005);
  const dipole = { start: [-0.24, 0, height], end: [0.24, 0, height] };
  let reference;
  const model = await createNecModel();
  try {
    model.addWire({ tag: 1, segments: 11, start: dipole.start, end: dipole.end, radiusM: RADIUS_M });
    model.completeGeometry();
    model.definePorts([{ tag: 1, segment: 6 }]);
    model.setGround(ground);
    model.prepare({ frequencyMHz: FREQUENCY_MHZ });
    reference = entry(model.computeImpedanceMatrix().impedance, 0, 0);
  } finally {
    model.dispose();
  }
  const deviations = [];
  for (const spacingM of [Math.sqrt(7), Math.sqrt(47), Math.sqrt(311)]) {
    const cell = await wireCell([dipole], { ground, lattice: { a1M: [spacingM, 0], a2M: [0, spacingM] } });
    try {
      const scan = cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0, 0] });
      deviations.push(distance(entry(scan.impedance, 0, 0), reference) / magnitude(reference));
    } finally {
      cell.dispose();
    }
  }
  const label = `${deviations}; isolated ${reference}`;
  assert.ok(deviations[0] > deviations[1] && deviations[1] > deviations[2], label);
  assert.ok(deviations[2] < 0.01, label);
});

test("scan impedance over finite ground matches the centre of a large finite array over Sommerfeld-Norton ground", {
  skip,
  timeout: 300_000,
}, async () => {
  // A quarter-wave height off broadside, as over perfect ground (issue #26):
  // the soil's exact reflection of every Floquet mode, evanescent ones
  // included, against NEC's Sommerfeld-Norton ground of a 15 x 15 array.
  // Measured 2.7 %, falling to 1.9 % at 21 x 21: the finite array's edge
  // error. With reflection-coefficient ground instead, the finite array stays
  // 2.9 % and 3.0 % off: that approximation, not the periodic route.
  const a1M = [0.6, 0];
  const a2M = [0, 0.5];
  const psi = [-0.9, 0.5];
  const ground = soil(13, 0.005, "sommerfeld-norton");
  const cell = await wireCell([X_DIPOLE], { ground, lattice: { a1M, a2M } });
  let periodic;
  try {
    periodic = entry(cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: psi }).impedance, 0, 0);
  } finally {
    cell.dispose();
  }
  const finite = entry(await finiteArrayCentreImpedance({
    frequencyMHz: FREQUENCY_MHZ,
    a1M,
    a2M,
    cells: 7,
    sigmaM: 1.8,
    psi,
    wires: [dipoleWire("dipole", [0, 0, 0.25])],
    ports: [{ wireId: "dipole", segment: FEED_SEGMENT }],
    ground,
  }), 0, 0);
  const relative = distance(periodic, finite) / magnitude(periodic);
  assert.ok(relative < 0.05, `periodic ${periodic}, finite ${finite}, relative ${relative}`);
});

const SLAB = { topZM: 0.1, layers: [{ thicknessM: 0.1, relativePermittivity: 4, lossTangent: 0.3 }] };
const RADOME = { bottomZM: 0.45, layers: [{ thicknessM: 0.05, relativePermittivity: 4, lossTangent: 0.02 }] };

test("power closes with a grounded slab, a free-standing stack and finite ground below", { skip, timeout: 300_000 }, async () => {
  // Port input power returns as the Floquet power above (and below, in free
  // space) plus the loss in the stacks and the power taken by the soil. 21
  // segments: the moment method's own power error is about 1e-3 (issue #29).
  // Measured 5.9e-4 to 9.6e-4, with 13 to 49 % of the input lost below.
  const cases = [
    ["perfect ground, slab resting on it", PERFECT, { below: SLAB }],
    ["perfect ground, slab with air under it", PERFECT, {
      below: { topZM: 0.1, layers: [{ thicknessM: 0.01, relativePermittivity: 10, lossTangent: 0.5 },
        { thicknessM: 0.03, relativePermittivity: 2.2, lossTangent: 0.02 }] },
    }],
    ["free space, stack below", undefined, { below: SLAB }],
    ["finite ground", soil(13, 0.005), {}],
    ["finite ground under a slab", soil(5, 0.05), { below: { topZM: 0.12, layers: [{ thicknessM: 0.06, relativePermittivity: 3, lossTangent: 0.1 }] } }],
    ["perfect ground, stacks above and below", PERFECT, { above: RADOME, below: SLAB }],
  ];
  for (const [name, ground, stacks] of cases) {
    const cell = await wireCell([X_DIPOLE], { ground, segments: 21 });
    try {
      cell.setLayeredStacks(stacks);
      for (const scanPhasesRad of [[0, 0], [1.5, 0], [0, 1.2]]) {
        const result = cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad });
        const [power] = result.floquet.powerBudget;
        const returned = power.propagatingW + power.lossW + power.dielectricLossW;
        const label = `${name}, scan ${scanPhasesRad}: ${JSON.stringify(power)}`;
        assert.ok(power.dielectricLossW > 0.05 * power.inputW, label);
        assert.ok(Math.abs(returned - power.inputW) < 2e-3 * power.inputW, label);
        assert.equal(result.floquet.modes.some((mode) => mode.side === "below"), ground === undefined, label);
      }
    } finally {
      cell.dispose();
    }
  }
});

const shifted = (dz) => ({ start, end }) => ({
  start: [start[0], start[1], start[2] + dz],
  end: [end[0], end[1], end[2] + dz],
});
const mirrored = (height) => ({ start, end }) => ({
  start: [start[0], start[1], height - start[2]],
  end: [end[0], end[1], height - end[2]],
});
const CONDUCTOR = [{ thicknessM: 0.05, relativePermittivity: 1, lossTangent: 1e12 }];

test("a highly conducting layer below acts as perfect ground at its upper face, also under a stack", {
  skip,
  timeout: 120_000,
}, async () => {
  // An independent route: a conducting layer below a free-space cell is the
  // perfect ground of the cell lowered onto z = 0, solved by images. A layer
  // of loss tangent 1e12 reflects as -1 to about 1e-6; measured 2.0e-6
  // alone and 1.6e-6 under the radome.
  const face = 0.02;
  const wires = [X_DIPOLE, TILTED];
  for (const above of [undefined, RADOME]) {
    const request = { frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0.8, -0.6] };
    const layered = await wireCell(wires);
    const grounded = await wireCell(wires.map(shifted(-face)), { ground: PERFECT });
    try {
      layered.setLayeredStacks({ ...(above ? { above } : {}), below: { topZM: face, layers: CONDUCTOR } });
      if (above) grounded.setLayeredStacks({ above: { ...above, bottomZM: above.bottomZM - face } });
      const error = relativeMatrixError(layered.computeScanImpedance(request).impedance,
        grounded.computeScanImpedance(request).impedance);
      assert.ok(error < 1e-5, `stack above ${Boolean(above)}: ${error}`);
    } finally {
      layered.dispose();
      grounded.dispose();
    }
  }
});

test("a conducting layer above and a stack below act as the mirrored cell over perfect ground", {
  skip,
  timeout: 120_000,
}, async () => {
  // The stack below a cell capped by a conductor at z = H is the stack above
  // the mirrored cell (z -> H - z) over perfect ground: the general two-sided
  // reflection against the image route with the stack above (issue #32).
  // Measured 8.1e-7 to 2.7e-6, the stack losses within 3e-6 of the input.
  const height = 0.6;
  const wires = [X_DIPOLE, TILTED];
  const layers = [{ thicknessM: 0.04, relativePermittivity: 4, lossTangent: 0.1 },
    { thicknessM: 0.03, relativePermittivity: 2.2 }];
  for (const scanPhasesRad of [[0, 0], [0.8, -0.6], [2.6, 0.4]]) {
    const request = { frequencyMHz: FREQUENCY_MHZ, scanPhasesRad };
    const capped = await wireCell(wires);
    const mirror = await wireCell(wires.map(mirrored(height)), { ground: PERFECT });
    try {
      capped.setLayeredStacks({
        above: { bottomZM: height, layers: CONDUCTOR },
        below: { topZM: 0.08, layers },
      });
      mirror.setLayeredStacks({ above: { bottomZM: height - 0.08, layers } });
      const covered = capped.computeScanImpedance(request);
      const image = mirror.computeScanImpedance(request);
      const error = relativeMatrixError(covered.impedance, image.impedance);
      assert.ok(error < 1e-5, `scan phases ${scanPhasesRad}: ${error}`);
      covered.floquet.powerBudget.forEach((power, port) => {
        const reference = image.floquet.powerBudget[port];
        assert.ok(Math.abs(power.dielectricLossW - reference.dielectricLossW) < 1e-4 * power.inputW);
      });
    } finally {
      capped.dispose();
      mirror.dispose();
    }
  }
});

test("a layer of relative permittivity 1 below changes nothing, also under a radome", { skip, timeout: 120_000 }, async () => {
  // With both stacks, the vacuum limit of one leaves the other alone.
  for (const [ground, above] of [
    [undefined, undefined], [PERFECT, undefined], [soil(13, 0.005), undefined],
    [undefined, RADOME], [PERFECT, RADOME], [soil(13, 0.005), RADOME],
  ]) {
    const cell = await wireCell([X_DIPOLE, TILTED], { ground });
    try {
      const request = { frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0.8, -0.6], evanescentModes: [{ p: 1, q: 0 }] };
      const extra = above ? { above } : {};
      cell.setLayeredStacks(extra);
      const bare = cell.computeScanImpedance(request);
      cell.setLayeredStacks({ ...extra, below: { topZM: 0.08, layers: [{ thicknessM: 0.05, relativePermittivity: 1 }] } });
      const covered = cell.computeScanImpedance(request);
      // Measured 0 (free space: no reflection at all), 2e-14 (perfect ground)
      // and 7e-11 (soil: the reflection now referred to the stack's face).
      const error = relativeMatrixError(covered.impedance, bare.impedance);
      assert.ok(error < 1e-9, `ground ${ground?.kind}, radome ${Boolean(above)}: ${error}`);
      // The gap is from the lowest point of a wire axis (the tilted one, 0.12 m) to the stack.
      assert.ok(Math.abs(covered.diagnostics.layeredStack.gapM - 0.04) < 1e-12);
    } finally {
      cell.dispose();
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

test("in free space, the modes below a stack are the transmitted waves", { skip, timeout: 120_000 }, async () => {
  // As above the array (issue #32): far below the wires a half-wave window
  // at broadside transmits the (0, 0) mode with T = -1, so the wave below is
  // the bare one times T exp(j kz d).
  const thicknessM = Math.PI / (2 * WAVENUMBER_PER_M);
  const cell = await wireCell([TILTED]);
  try {
    const request = { frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0, 0] };
    const bare = cell.computeScanImpedance(request);
    cell.setLayeredStacks({ below: { topZM: -1.4, layers: [{ thicknessM, relativePermittivity: 4 }] } });
    const covered = cell.computeScanImpedance(request);
    const phase = WAVENUMBER_PER_M * thicknessM;
    assert.ok(scaledAmplitudeError(broadsideMode(covered, "below"), broadsideMode(bare, "below"),
      [-Math.cos(phase), -Math.sin(phase)]) < 1e-5);
    assert.ok(scaledAmplitudeError(broadsideMode(covered), broadsideMode(bare), [1, 0]) < 1e-5);
    assert.ok(relativeMatrixError(covered.impedance, bare.impedance) < 1e-5);
  } finally {
    cell.dispose();
  }
});

test("the lower stack's terms are reciprocal: dZ(psi) = dZ(-psi)^T", { skip, timeout: 120_000 }, async () => {
  // NEC's point matching is not reciprocal for the strong evanescent coupling
  // across the slab's 0.02 m gap to the tilted wire: measured 2.6e-4 (free
  // space), 1.3e-3 (perfect ground) and 5.9e-4 (soil) of the largest entry of
  // the slab's change dZ at 21 segments, about three times more at 11. A
  // wrong or transposed term would leave the asymmetry of dZ, 0.21 to 0.49.
  for (const ground of [undefined, PERFECT, soil(13, 0.005)]) {
    const cell = await wireCell([X_DIPOLE, TILTED], { ground, segments: 21 });
    try {
      const change = (scanPhasesRad) => {
        cell.setLayeredStacks({});
        const bare = cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad }).impedance;
        cell.setLayeredStacks({ below: SLAB });
        const covered = cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad }).impedance;
        const minus = (part) => covered[part].map((value, index) => value - bare[part][index]);
        return { rows: 2, columns: 2, real: minus("real"), imag: minus("imag") };
      };
      const forward = change([1.1, -0.7]);
      const backward = change([-1.1, 0.7]);
      const transpose = (part) => Float64Array.from([0, 2, 1, 3], (index) => backward[part][index]);
      const error = relativeMatrixError(forward, { ...backward, real: transpose("real"), imag: transpose("imag") });
      assert.ok(error < 3e-3, `ground ${ground?.kind}: ${error}`);
    } finally {
      cell.dispose();
    }
  }
});

const geometryError = (pattern) => (error) => error instanceof NecGeometryError && pattern.test(error.message);

test("below the wires, conductor entry and too small a gap are refused as above", { skip, timeout: 120_000 }, async () => {
  const request = { frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0, 0] };
  const layers = SLAB.layers.map((layer) => ({ ...layer, thicknessM: 0.05 }));
  const cell = await wireCell([X_DIPOLE, TILTED]);
  try {
    // The tilted wire reaches down to z = 0.12 at its axis, 0.119 with its radius.
    assert.throws(() => cell.setLayeredStacks({ below: { topZM: 0.1195, layers } }),
      geometryError(/ENTERS THE LAYERED STACK BELOW THE WIRES: SEGMENT \d+ \(TAG 2\)/));
    // Refused without effect: the cell still solves bare.
    assert.equal(cell.computeScanImpedance(request).diagnostics.layeredStack, undefined);

    cell.setLayeredStacks({ below: { topZM: 0.118, layers } });
    assert.throws(() => cell.computeScanImpedance(request),
      geometryError(/^LAYERED STACK TOO CLOSE TO THE WIRES: A GAP OF 0\.002 M .* NEEDS ABOUT \d+ FLOQUET MODES/));

    // In free space a lower stack may reach below z = 0; over ground it may not.
    cell.setLayeredStacks({ below: { topZM: 0.05, layers: [{ thicknessM: 0.08, relativePermittivity: 3 }] } });
    cell.computeScanImpedance(request);
    for (const ground of [PERFECT, soil(13, 0.005)]) {
      assert.throws(() => cell.setGround(ground), geometryError(/REACHES INTO THE GROUND: ITS LOWEST FACE IS AT Z = -0\.03 M/));
    }
    cell.setLayeredStacks({});
    cell.setGround(PERFECT);
    assert.throws(() => cell.setLayeredStacks({ below: { topZM: 0.05, layers: [{ thicknessM: 0.08, relativePermittivity: 3 }] } }),
      geometryError(/REACHES INTO THE GROUND/));

    for (const stacks of [
      { below: { bottomZM: 0.05, layers } },
      { below: { topZM: 0.05, layers: [] } },
      { below: { topZM: Number.POSITIVE_INFINITY, layers } },
      { beside: { topZM: 0.05, layers } },
    ]) {
      assert.throws(() => cell.setLayeredStacks(stacks), NecInputError, JSON.stringify(stacks));
    }
  } finally {
    cell.dispose();
  }

  // Finite ground: a wire must not touch it, and the gap to it sets the modes too.
  const low = await createNecPeriodicModel();
  try {
    low.addWire({ tag: 1, segments: 11, start: [-0.24, 0, 0.003], end: [0.24, 0, 0.003], radiusM: RADIUS_M });
    low.completeGeometry();
    low.definePorts([{ tag: 1, segment: 6 }]);
    low.setLattice(LATTICE);
    low.setGround(soil(13, 0.005));
    assert.throws(() => low.computeScanImpedance(request),
      geometryError(/^FINITE GROUND TOO CLOSE TO THE WIRES: A GAP OF 0\.003 M/));
  } finally {
    low.dispose();
  }
  const lying = await createNecPeriodicModel();
  try {
    lying.addWire({ tag: 1, segments: 11, start: [-0.24, 0, 0.0005], end: [0.24, 0, 0.0005], radiusM: RADIUS_M });
    lying.completeGeometry();
    lying.definePorts([{ tag: 1, segment: 6 }]);
    lying.setLattice(LATTICE);
    assert.throws(() => lying.setGround(soil(13, 0.005)), geometryError(/CONDUCTOR ENTERS THE FINITE GROUND/));
  } finally {
    lying.dispose();
  }
});

test("over finite ground and with a stack below, the scan impedance is continuous through a Wood anomaly", {
  skip,
  timeout: 300_000,
}, async () => {
  // As with the stack above (issue #32): the (1, 0) mode reaches cut-off near
  // psi1 = 2.5 (0.6 m cells). Bisect on the engine's own kz of that mode down
  // to floating-point resolution, from both sides; there the reflections
  // from below nearly cancel the kernel's split singular part (over perfect
  // ground its TM part, doubled by the image, against the slab's).
  for (const [ground, stacks] of [
    [soil(13, 0.005), {}],
    [soil(13, 0.005), { above: RADOME, below: SLAB }],
    [PERFECT, { below: SLAB }],
    [undefined, { below: SLAB }],
  ]) {
    const cell = await wireCell([TILTED], { ground });
    try {
      cell.setLayeredStacks(stacks);
      const side = ground === undefined ? "below" : "above";
      const solve = (psi1) => cell.computeScanImpedance({
        frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [psi1, 0.3], evanescentModes: [{ p: 1, q: 0 }],
      });
      const kz = (result) => result.floquet.modes.find((mode) => mode.p === 1 && mode.q === 0 && mode.side === side).kzRadPerM;
      let [evanescent, propagating] = [2.3, 2.7];
      for (let step = 0; step < 60 && propagating - evanescent > 1e-15; step += 1) {
        const middle = (evanescent + propagating) / 2;
        if (middle === evanescent || middle === propagating) break;
        if (kz(solve(middle))[1] < 0) evanescent = middle;
        else propagating = middle;
      }
      const results = [evanescent, propagating].map(solve);
      const label = `ground ${ground?.kind}, stacks ${Object.keys(stacks)}`;
      for (const result of results) {
        assert.equal(result.diagnostics.status, "near-cutoff", label);
        assert.ok(Math.hypot(...kz(result)) < 1e-6, `${label}: kz ${kz(result)}`);
        assert.ok(result.diagnostics.estimatedError < 1e-5, label);
        assert.ok(entry(result.impedance, 0, 0).every(Number.isFinite), label);
      }
      const jump = relativeMatrixError(results[0].impedance, results[1].impedance);
      assert.ok(jump < 1e-5, `${label}: ${jump}`);
      const nearby = relativeMatrixError(solve(propagating + 1e-10).impedance, results[1].impedance);
      assert.ok(nearby < 1e-3, `${label}: ${nearby}`);
    } finally {
      cell.dispose();
    }
  }
});

test("sweep workers replay the stack below and the finite ground", { skip, timeout: 120_000 }, async () => {
  const cell = await wireCell([X_DIPOLE, TILTED], { ground: soil(5, 0.05) });
  try {
    cell.setLayeredStacks({ above: RADOME, below: { topZM: 0.08, layers: [{ thicknessM: 0.05, relativePermittivity: 3, lossTangent: 0.1 }] } });
    const scanStates = [{ scanPhasesRad: [0.3, 0.2] }, { scanDirection: { thetaDeg: 40, phiDeg: 30 } }];
    const swept = [];
    for await (const chunk of cell.sweepScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanStates }, { workers: 2 })) {
      swept.push(...chunk.points);
    }
    assert.equal(swept.length, 2);
    for (const { index, result } of swept) {
      const direct = cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, ...scanStates[index] });
      assert.ok(relativeMatrixError(result.impedance, direct.impedance) < 1e-12);
      assert.deepEqual(result.diagnostics, direct.diagnostics);
      assert.equal(result.floquet.powerBudget[0].dielectricLossW, direct.floquet.powerBudget[0].dielectricLossW);
    }
  } finally {
    cell.dispose();
  }
});
