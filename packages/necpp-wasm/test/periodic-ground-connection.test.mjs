// Wires that end on perfect ground (#47): monopoles, grounded bent elements
// and helices fed at the plane, with completeGeometry's interpolated ground
// connection. NEC's own ground connection treats the segment's image (its
// basis functions and its own ground image); the ground images of the other
// cells go through the periodic correction as for any cell over ground.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import {
  NecGeometryError,
  NecInputError,
  createNecModel,
  createNecPeriodicModel,
} from "../.test-build/src/index.js";
import { createNecPeriodicWorkerModel } from "../.test-build/src/worker.js";
import {
  FREQUENCY_MHZ,
  RADIUS_M,
  WAVENUMBER_PER_M,
  distance,
  entry,
  finiteArrayCentreImpedance,
  magnitude,
  relativeMatrixError,
} from "./periodic-reference.mjs";

const hasWasm = existsSync(new URL("../.test-build/src/nec2pp.wasm", import.meta.url));
const skip = !hasWasm && "WASM artifacts have not been built";

const PERFECT = { kind: "perfect" };
const INTERPOLATE = { groundConnection: "interpolate" };
const TOLERANCE = 1e-5;

/** A quarter-wave monopole standing on the plane at the origin as tag 1, fed at the plane. */
const monopole = (segments = 6) => ({
  tag: 1,
  segments,
  start: [0, 0, 0],
  end: [0, 0, 0.24],
  radiusM: RADIUS_M,
});

/**
 * Two inverted-L elements, a grounded bent cross: vertical roots of 4
 * segments at (0.05, 0) and (0, 0.05), arms along x and y at 0.12 m. Ports on
 * the segments at the plane.
 */
const invertedLs = [
  { tag: 1, segments: 4, start: [0.05, 0, 0], end: [0.05, 0, 0.12], radiusM: RADIUS_M },
  { tag: 2, segments: 5, start: [0.05, 0, 0.12], end: [0.2, 0, 0.12], radiusM: RADIUS_M },
  { tag: 3, segments: 4, start: [0, 0.05, 0], end: [0, 0.05, 0.12], radiusM: RADIUS_M },
  { tag: 4, segments: 5, start: [0, 0.05, 0.12], end: [0, 0.2, 0.12], radiusM: RADIUS_M },
];
const INVERTED_L_PORTS = [{ tag: 1, segment: 1 }, { tag: 3, segment: 1 }];

/** An axial-mode helix of circumference one wavelength, 7 turns of 12 segments, rising from the plane. */
function groundedHelix() {
  const at = (i) => {
    const angle = 2 * Math.PI * i / 12;
    return [0.159 * Math.cos(angle), 0.159 * Math.sin(angle), 0.23 * i / 12];
  };
  return Array.from({ length: 84 }, (_, i) => ({ tag: i + 1, segments: 1, start: at(i), end: at(i + 1), radiusM: 0.002 }));
}

async function groundedCell(wires, ports, lattice) {
  const cell = await createNecPeriodicModel();
  for (const wire of wires) cell.addWire(wire);
  cell.completeGeometry(INTERPOLATE);
  cell.definePorts(ports);
  cell.setGround(PERFECT);
  if (lattice !== undefined) cell.setLattice(lattice);
  return cell;
}

/** psi_i = -kt . a_i for the transverse wavevector kt (rad/m). */
const phasesOf = (lattice, [kx, ky]) => [
  -(kx * lattice.a1M[0] + ky * lattice.a1M[1]),
  -(kx * lattice.a2M[0] + ky * lattice.a2M[1]),
];

function towards(thetaDeg, phiDeg) {
  const sine = Math.sin(thetaDeg * Math.PI / 180);
  return [WAVENUMBER_PER_M * sine * Math.cos(phiDeg * Math.PI / 180), WAVENUMBER_PER_M * sine * Math.sin(phiDeg * Math.PI / 180)];
}

/** b1 of the lattice: b1 . a1 = 2 pi, b1 . a2 = 0. */
function firstReciprocal({ a1M, a2M }) {
  const det = a1M[0] * a2M[1] - a1M[1] * a2M[0];
  return [2 * Math.PI * a2M[1] / det, -2 * Math.PI * a2M[0] / det];
}

/**
 * Scan states that exercise the periodic correction: broadside, an oblique
 * scan, a scan with the (-1, 0) grating lobe, and two past the (-1, 0) Wood
 * anomaly (kt0 along b1 with |kt0 - b1| = (1 + offset) k): 1e-3, and 1e-8,
 * where the mode is split into the low-rank update.
 */
function scanStates(lattice) {
  const b1 = firstReciprocal(lattice);
  const length = Math.hypot(...b1);
  const pastCutoff = (offset) => {
    const along = length - (1 + offset) * WAVENUMBER_PER_M;
    return phasesOf(lattice, [along * b1[0] / length, along * b1[1] / length]);
  };
  return [
    ["broadside", [0, 0]],
    ["oblique", phasesOf(lattice, towards(35, 25))],
    ["grating lobe", phasesOf(lattice, towards(70, 0))],
    ["next to a Wood anomaly", pastCutoff(1e-3)],
    ["on the edge of a Wood anomaly", pastCutoff(1e-8)],
  ];
}

/** A free-space model's port impedance matrix at FREQUENCY_MHZ, or with a lattice and scan phases. */
async function freeSpaceImpedance(wires, ports, lattice, scanPhasesRad) {
  if (lattice === undefined) {
    const model = await createNecModel();
    try {
      for (const wire of wires) model.addWire(wire);
      model.completeGeometry();
      model.definePorts(ports);
      model.prepare({ frequencyMHz: FREQUENCY_MHZ });
      return model.computeImpedanceMatrix().impedance;
    } finally {
      model.dispose();
    }
  }
  const cell = await createNecPeriodicModel();
  try {
    for (const wire of wires) cell.addWire(wire);
    cell.completeGeometry();
    cell.definePorts(ports);
    cell.setLattice(lattice);
    return cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad }).impedance;
  } finally {
    cell.dispose();
  }
}

/** The finite model's port impedance matrix of grounded wires over perfect ground. */
async function finiteGroundedImpedance(wires, ports) {
  const model = await createNecModel();
  try {
    for (const wire of wires) model.addWire(wire);
    model.completeGeometry(INTERPOLATE);
    model.definePorts(ports);
    model.setGround(PERFECT);
    model.prepare({ frequencyMHz: FREQUENCY_MHZ });
    return model.computeImpedanceMatrix().impedance;
  } finally {
    model.dispose();
  }
}

/**
 * Image theory for grounded wires: in free space, every wire together with
 * its mirror image; a root that ends on the plane becomes one wire through
 * it with twice the segments, fed on both segments at the plane alike (the
 * image of a vertical current runs the same way). So port p of the grounded
 * cell is the pair (2p, 2p + 1) of the free-space cell, and
 * Z[p][q] = Zf[2p][2q] + Zf[2p][2q + 1].
 */
function mirrorCell(wires, ports) {
  const mirrored = [];
  const freePorts = [];
  let tag = 0;
  const tags = new Map();
  for (const wire of wires) {
    tag += 1;
    tags.set(wire.tag, tag);
    if (wire.start[2] === 0) {
      mirrored.push({ ...wire, tag, segments: 2 * wire.segments, start: [wire.start[0], wire.start[1], -wire.end[2]] });
    } else {
      mirrored.push({ ...wire, tag });
      tag += 1;
      mirrored.push({ ...wire, tag, start: [wire.start[0], wire.start[1], -wire.start[2]], end: [wire.end[0], wire.end[1], -wire.end[2]] });
    }
  }
  for (const port of ports) {
    const wire = wires.find((candidate) => candidate.tag === port.tag);
    assert.equal(port.segment, 1, "ports on the segment at the plane");
    freePorts.push({ tag: tags.get(port.tag), segment: wire.segments + 1 });
    freePorts.push({ tag: tags.get(port.tag), segment: wire.segments });
  }
  return { wires: mirrored, ports: freePorts };
}

function imageImpedance(free, ports) {
  const real = new Float64Array(ports * ports);
  const imag = new Float64Array(ports * ports);
  for (let p = 0; p < ports; p += 1) {
    for (let q = 0; q < ports; q += 1) {
      const [ar, ai] = entry(free, 2 * p, 2 * q);
      const [br, bi] = entry(free, 2 * p, 2 * q + 1);
      real[p * ports + q] = ar + br;
      imag[p * ports + q] = ai + bi;
    }
  }
  return { rows: ports, columns: ports, real, imag };
}

for (const [name, wires, ports, lattice] of [
  ["a grounded monopole", [monopole()], [{ tag: 1, segment: 1 }], { a1M: [0.6, 0], a2M: [0.1, 0.5] }],
  ["a cell of two grounded inverted-L elements", invertedLs, INVERTED_L_PORTS, { a1M: [0.55, 0], a2M: [0.1, 0.5] }],
]) {
  test(`over perfect ground, ${name} matches its mirror image in free space`, {
    skip,
    timeout: 120_000,
  }, async () => {
    const mirror = mirrorCell(wires, ports);
    // NEC's own ground connection agrees with its image to this much without
    // a lattice (6.6e-8 for the monopole); the periodic cell adds nothing.
    const finiteModelError = relativeMatrixError(
      await finiteGroundedImpedance(wires, ports),
      imageImpedance(await freeSpaceImpedance(mirror.wires, mirror.ports), ports.length),
    );
    assert.ok(finiteModelError < 1e-6, `finite model ${finiteModelError}`);
    const cell = await groundedCell(wires, ports, lattice);
    try {
      for (const [state, scanPhasesRad] of scanStates(lattice)) {
        const result = cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad });
        assert.equal(result.diagnostics.status, state === "on the edge of a Wood anomaly" ? "near-cutoff" : "ok", state);
        const grounded = result.impedance;
        const image = imageImpedance(
          await freeSpaceImpedance(mirror.wires, mirror.ports, lattice, scanPhasesRad),
          ports.length,
        );
        const error = relativeMatrixError(grounded, image);
        assert.ok(error < 1.5 * finiteModelError + 1e-10, `${state}: ${error}, finite model ${finiteModelError}`);
      }
    } finally {
      cell.dispose();
    }
  });
}

test("a grounded monopole's scan impedance matches the centre of a growing finite array over ground", {
  skip,
  timeout: 600_000,
}, async () => {
  const lattice = { a1M: [0.6, 0], a2M: [0, 0.5] };
  const psi = [-0.9, 0.5];
  const cell = await groundedCell([monopole()], [{ tag: 1, segment: 1 }], lattice);
  let periodic;
  try {
    periodic = entry(cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: psi }).impedance, 0, 0);
  } finally {
    cell.dispose();
  }
  const deviations = [];
  for (const [cells, sigmaM] of [[5, 1.3], [9, 2.3]]) {
    const centre = entry(await finiteArrayCentreImpedance({
      frequencyMHz: FREQUENCY_MHZ,
      ...lattice,
      cells,
      sigmaM,
      psi,
      wires: [{ id: "monopole", segments: 6, startM: [0, 0, 0], endM: [0, 0, 0.24], radiusM: RADIUS_M }],
      ports: [{ wireId: "monopole", segment: 1 }],
      ground: PERFECT,
      groundConnection: "interpolate",
    }), 0, 0);
    deviations.push(distance(periodic, centre) / magnitude(periodic));
  }
  // The finite array's edge error falls as it grows: measured 16 % at
  // 11 x 11, 3.5 % at 19 x 19 and 2.9 % at 27 x 27. Vertical monopoles
  // couple through a field that falls only as 1 / R along the ground, so the
  // edge reaches further in than for horizontal dipoles over ground.
  assert.ok(deviations[1] < deviations[0] / 3, `${deviations}`);
  assert.ok(deviations[1] < 0.05, `${deviations}`);
});

test("a grounded monopole at a very large lattice spacing approaches the isolated monopole", {
  skip,
  timeout: 300_000,
}, async () => {
  const isolated = entry(await finiteGroundedImpedance([monopole()], [{ tag: 1, segment: 1 }]), 0, 0);
  // Squared spacings (in wavelengths) between sums of two squares, so that no
  // Floquet mode sits near cut-off.
  const deviations = [];
  for (const spacingM of [Math.sqrt(7), Math.sqrt(47), Math.sqrt(311)]) {
    const cell = await groundedCell([monopole()], [{ tag: 1, segment: 1 }],
      { a1M: [spacingM, 0], a2M: [0, spacingM] });
    try {
      const scan = cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0, 0] });
      deviations.push(distance(entry(scan.impedance, 0, 0), isolated) / magnitude(isolated));
    } finally {
      cell.dispose();
    }
  }
  // Measured 52 %, 26 % and 14 %: about halved at each step. The monopole
  // radiates most along the ground, where the Floquet modes are densest and
  // nearest grazing, so it approaches more slowly than a horizontal dipole.
  assert.ok(deviations[1] < deviations[0] / 1.5 && deviations[2] < deviations[1] / 1.5, `${deviations}`);
  assert.ok(deviations[2] < 0.15, `${deviations}`);
});

test("a grounded monopole's input power is the propagating Floquet power above it, to the discretization error", {
  skip,
  timeout: 120_000,
}, async () => {
  const lattice = { a1M: [0.6, 0], a2M: [0.1, 0.5] };
  const psi = phasesOf(lattice, towards(35, 25));
  const closures = [];
  for (const segments of [6, 12, 24]) {
    const cell = await groundedCell([monopole(segments)], [{ tag: 1, segment: 1 }], lattice);
    try {
      const { floquet } = cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: psi });
      // Over ground the modes propagate above the cell only.
      assert.ok(floquet.modes.every((mode) => mode.side === "above"));
      const [{ inputW, propagatingW, lossW }] = floquet.powerBudget;
      assert.equal(lossW, 0);
      closures.push(Math.abs(inputW - propagatingW) / inputW);
    } finally {
      cell.dispose();
    }
  }
  // Measured 8.7e-4, 1.8e-4 and 1.4e-5: the wire's discretization error.
  assert.ok(closures[0] < 2e-3 && closures[1] < closures[0] / 2 && closures[2] < closures[1] / 2, `${closures}`);
});

test("a grounded multi-port cell is reciprocal as Z(psi) = Z(-psi)^T, to the discretization error", {
  skip,
  timeout: 120_000,
}, async () => {
  const lattice = { a1M: [0.55, 0], a2M: [0.1, 0.5] };
  const psi = phasesOf(lattice, towards(35, 25));
  const errors = [];
  for (const refinement of [1, 2]) {
    const wires = invertedLs.map((wire) => ({ ...wire, segments: refinement * wire.segments }));
    const cell = await groundedCell(wires, INVERTED_L_PORTS, lattice);
    try {
      const forward = cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: psi });
      // The bends' discretization error, as for any cell (5e-3 at these
      // segments; 2.5e-2 with the elements lifted 1 cm off the plane).
      for (const { inputW, propagatingW } of forward.floquet.powerBudget) {
        assert.ok(Math.abs(inputW - propagatingW) < 1e-2 * inputW, `${inputW} vs ${propagatingW}`);
      }
      const backward = cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [-psi[0], -psi[1]] });
      const transposed = {
        rows: 2,
        columns: 2,
        real: Float64Array.from([0, 2, 1, 3], (index) => backward.impedance.real[index]),
        imag: Float64Array.from([0, 2, 1, 3], (index) => backward.impedance.imag[index]),
      };
      errors.push(relativeMatrixError(forward.impedance, transposed));
      const z = forward.impedance;
      const asymmetry = distance(entry(z, 0, 1), entry(z, 1, 0)) / magnitude(entry(z, 0, 1));
      assert.ok(asymmetry > 0.01, `Z(psi) should not be symmetric: ${asymmetry}`);
    } finally {
      cell.dispose();
    }
  }
  // Measured 2.3e-3 and 1.2e-3. The free-space mirror cell is reciprocal to
  // 3.2e-5 as a 4 x 4 matrix, but its two gaps of a port combine into the
  // grounded port only through its mirror symmetry, which NEC's junctions
  // keep to first order in the segment length: combined as image theory
  // says, it gives the same 2.3e-3. (NEC's finite model with this ground
  // connection is no more reciprocal: 1.1e-2 for a tilted grounded pair.)
  assert.ok(errors[0] < 3e-3 && errors[1] < errors[0] / 1.6, `${errors}`);

  // One port: Z(psi) = Z(-psi).
  const cell = await groundedCell([monopole()], [{ tag: 1, segment: 1 }], lattice);
  try {
    const forward = entry(cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: psi }).impedance, 0, 0);
    const backward = entry(cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [-psi[0], -psi[1]] }).impedance, 0, 0);
    assert.ok(distance(forward, backward) < 1e-3 * magnitude(forward), `${forward} vs ${backward}`);
  } finally {
    cell.dispose();
  }
});

test("an axial-mode helix fed at the plane gives a scan impedance and a scan element pattern", {
  skip,
  timeout: 600_000,
}, async () => {
  const lattice = { a1M: [0.8, 0], a2M: [0, 0.8] };
  const cell = await groundedCell(groundedHelix(), [{ tag: 1, segment: 1 }], lattice);
  try {
    const result = cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanDirection: { thetaDeg: 30, phiDeg: 20 } });
    assert.equal(result.diagnostics.status, "ok");
    assert.ok(result.diagnostics.estimatedError <= TOLERANCE, JSON.stringify(result.diagnostics));
    const [r] = entry(result.impedance, 0, 0);
    assert.ok(r > 0, `${entry(result.impedance, 0, 0)}`);
    // A coarse pattern without refinement, so that the test stays short.
    const pattern = await cell.computeScanElementPattern(
      { frequencyMHz: FREQUENCY_MHZ, grid: { spacingUV: 0.25 }, refinement: false },
      { workers: 2 },
    );
    assert.deepEqual(pattern.sides, ["above"]);
    const away = pattern.samples.filter((sample) => sample.woodCircles.length === 0 && sample.diagnostics.status === "ok");
    assert.ok(away.length > pattern.samples.length / 2, `${away.length} of ${pattern.samples.length}`);
    for (const sample of away) {
      assert.ok(sample.diagnostics.estimatedError <= TOLERANCE, JSON.stringify(sample.diagnostics));
    }
    const broadside = pattern.evaluate({ u: 0, v: 0 });
    assert.ok(magnitude([broadside.te.real[0], broadside.te.imag[0]]) + magnitude([broadside.tm.real[0], broadside.tm.imag[0]]) > 0);
  } finally {
    cell.dispose();
  }
});

test("the sweep workers and the worker model replay the ground connection", { skip, timeout: 120_000 }, async () => {
  const lattice = { a1M: [0.6, 0], a2M: [0.1, 0.5] };
  const states = scanStates(lattice).map(([, scanPhasesRad]) => ({ scanPhasesRad }));
  const cell = await groundedCell([monopole()], [{ tag: 1, segment: 1 }], lattice);
  const worker = await createNecPeriodicWorkerModel();
  try {
    const singles = states.map((state) => cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, ...state }));
    const swept = [];
    for await (const chunk of cell.sweepScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanStates: states }, { workers: 2 })) {
      for (const { index, result } of chunk.points) swept[index] = result;
    }
    await worker.addWire(monopole());
    await worker.completeGeometry(INTERPOLATE);
    await worker.definePorts([{ tag: 1, segment: 1 }]);
    await worker.setGround(PERFECT);
    await worker.setLattice(lattice);
    for (const [index, single] of singles.entries()) {
      assert.deepEqual(swept[index].impedance, single.impedance);
      const remote = await worker.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, ...states[index] });
      assert.deepEqual(remote.impedance, single.impedance);
    }
  } finally {
    cell.dispose();
    await worker.dispose();
  }
});

test("conductors reaching the plane without a supported ground connection are refused with the reason", {
  skip,
}, async () => {
  const lattice = { a1M: [0.6, 0], a2M: [0, 0.5] };
  const geometryRefusal = (pattern) => (error) => error instanceof NecGeometryError && pattern.test(error.message);

  // Refused by the geometry, as in the finite model: a wire lying in the
  // plane, and one crossing it.
  for (const [wire, reason] of [
    [{ tag: 1, segments: 5, start: [-0.2, 0, 0], end: [0.2, 0, 0], radiusM: RADIUS_M }, /LIES IN GROUND PLANE/],
    [{ tag: 1, segments: 6, start: [0, 0, -0.1], end: [0, 0, 0.2], radiusM: RADIUS_M }, /EXTENDS BELOW GROUND/],
  ]) {
    const cell = await createNecPeriodicModel();
    try {
      cell.addWire(wire);
      assert.throws(() => cell.completeGeometry(INTERPOLATE), geometryRefusal(reason));
      assert.equal(cell.state, "geometry-building");
    } finally {
      cell.dispose();
    }
  }

  // Without a connection, a wire on the plane is refused over perfect ground.
  {
    const cell = await createNecPeriodicModel();
    try {
      cell.addWire(monopole());
      cell.completeGeometry();
      cell.definePorts([{ tag: 1, segment: 1 }]);
      cell.setLattice(lattice);
      assert.throws(() => cell.setGround(PERFECT), geometryRefusal(/GROUND PLANE.*INTERPOLATED GROUND CONNECTION/));
    } finally {
      cell.dispose();
    }
  }

  // Nearly touching the plane, beyond the contact threshold: not connected.
  {
    const cell = await createNecPeriodicModel();
    try {
      cell.addWire({ ...monopole(), start: [0, 0, 0.0005], end: [0, 0, 0.2405] });
      cell.completeGeometry(INTERPOLATE);
      cell.definePorts([{ tag: 1, segment: 1 }]);
      cell.setGround(PERFECT);
      assert.throws(() => cell.setLattice(lattice), geometryRefusal(/GROUND PLANE/));
      // No lattice was set.
      assert.throws(() => cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0, 0] }),
        (error) => error.name === "NecStateError");
    } finally {
      cell.dispose();
    }
  }

  // A connection needs perfect ground: refused over finite ground, and in
  // free space at the first solve, as in the finite model.
  {
    const cell = await createNecPeriodicModel();
    try {
      cell.addWire(monopole());
      cell.completeGeometry(INTERPOLATE);
      cell.definePorts([{ tag: 1, segment: 1 }]);
      cell.setLattice(lattice);
      assert.throws(() => cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0, 0] }),
        geometryRefusal(/GROUND CONNECTION REQUIRES A GROUND MODEL/));
      assert.throws(() => cell.setGround({
        kind: "finite",
        method: "reflection-coefficient",
        relativePermittivity: 13,
        conductivitySPerM: 0.005,
      }), geometryRefusal(/GROUND CONNECTION IN PERIODIC MODE NEEDS PERFECT GROUND/));
      cell.setGround(PERFECT);
      const before = cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0, 0] }).impedance;
      // Touching its periodic image: refused, and the cell is unchanged.
      assert.throws(() => cell.setLattice({ a1M: [0.6, 0], a2M: [0, 0.0015] }), (error) => error instanceof NecGeometryError);
      assert.deepEqual(cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0, 0] }).impedance, before);
      // A stack below the wires: they must stay above it. A stack above works.
      assert.throws(() => cell.setLayeredStacks({ below: { topZM: 0.05, layers: [{ thicknessM: 0.05, relativePermittivity: 3 }] } }),
        geometryRefusal(/ENTERS THE LAYERED STACK BELOW THE WIRES/));
      assert.deepEqual(cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0, 0] }).impedance, before);
      cell.setLayeredStacks({ above: { bottomZM: 0.4, layers: [{ thicknessM: 0.02, relativePermittivity: 4 }] } });
      const radome = cell.computeScanImpedance({ frequencyMHz: FREQUENCY_MHZ, scanPhasesRad: [0, 0] });
      assert.equal(radome.diagnostics.status, "ok");
      assert.notDeepEqual(radome.impedance, before);
    } finally {
      cell.dispose();
    }
  }

  // Zero current at the plane is not supported, and the geometry stays open.
  {
    const cell = await createNecPeriodicModel();
    try {
      cell.addWire(monopole());
      assert.throws(() => cell.completeGeometry({ groundConnection: "zero-current" }),
        (error) => error instanceof NecInputError && /zero-current.*not supported in periodic mode/.test(error.message));
      assert.throws(() => cell.completeGeometry({ symmetry: { kind: "none" } }),
        (error) => error instanceof NecInputError && /symmetry is not supported/.test(error.message));
      assert.equal(cell.state, "geometry-building");
      cell.completeGeometry(INTERPOLATE);
    } finally {
      cell.dispose();
    }
  }
});
