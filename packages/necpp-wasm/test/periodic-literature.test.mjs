// Scan resistance of infinite planar dipole arrays against the literature:
//
//   L. Stark, "Radiation impedance of a dipole in an infinite planar phased
//   array," Radio Science, vol. 1 (new series), no. 3, pp. 361-377, March 1966,
//   eqs. (11), (20a) and (20b);
//   H. A. Wheeler, "The radiation resistance of an antenna in an infinite array
//   or waveguide," Proc. IRE, vol. 36, pp. 478-487, April 1948 (broadside, as
//   cited by Stark).
//
// Stark assumes half-wave dipoles with a sinusoidal current and takes the
// resistance from the one propagating Floquet mode (induced EMF). Over a
// ground plane at distance s, with a, b the spacings across and along the
// dipoles and (cos x, cos y, cos z) the direction cosines of the beam (normal,
// across, along the dipoles):
//
//   R = (120 / pi) (lambda^2 / (a b)) sin^2(k s cos x)
//       [cos(pi/2 cos z) / sin z]^2 / cos x,
//
// R_bs = (120 / pi) (lambda^2 / (a b)) sin^2(k s) at broadside (20a), times
// the scanning factor SF (20b). Without the image term of eq. (11), the
// free-space array gives (60 / pi) (lambda^2 / (a b)) [..]^2 / cos x.
//
// The moment method solves for the current instead of assuming it, so it
// differs from these closed forms by the current's departure from a
// sinusoid: at broadside by about 3 % for thin wires (as the isolated
// half-wave dipole differs from its EMF value of 73.1 ohm, by 6 % at a radius
// of 1e-5 wavelengths), and with scan, as Stark notes, by a slow change in the
// current distribution. The tolerances below are the measured deviations
// with some margin.
//
// Geometry: Stark's figure 8 (a = b = 0.5 wavelengths) puts half-wave
// dipoles end to end, a connected array, which the periodic solver refuses.
// Here the dipoles are 0.6 wavelengths apart along their axis (E-plane, no
// grating lobe below 41.8 degrees) and 0.5 across (H-plane, none at all).
// Beyond a grating-lobe onset Stark's curves part from the moment method by
// 10 to 25 %; a large finite array confirms the periodic result there (see
// docs/periodic-floquet-evaluation.md, issue #26).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { createNecPeriodicModel } from "../.test-build/src/index.js";

const hasWasm = existsSync(new URL("../.test-build/src/nec2pp.wasm", import.meta.url));
const skip = !hasWasm && "WASM artifacts have not been built";

// One-metre wavelength.
const FREQUENCY_MHZ = 299.792458;
const ALONG_M = 0.6; // b, along the dipoles (x)
const ACROSS_M = 0.5; // a, across the dipoles (y)
const HEIGHT_M = 0.25; // s
const SEGMENTS = 21;

async function scanResistance({ ground, thetaDeg, phiDeg }) {
  const cell = await createNecPeriodicModel();
  try {
    cell.addWire({
      tag: 1,
      segments: SEGMENTS,
      start: [-0.25, 0, HEIGHT_M],
      end: [0.25, 0, HEIGHT_M],
      radiusM: 1e-5,
    });
    cell.completeGeometry();
    cell.definePorts([{ tag: 1, segment: (SEGMENTS + 1) / 2 }]);
    if (ground) {
      cell.setGround({ kind: "perfect" });
    }
    cell.setLattice({ a1M: [ALONG_M, 0], a2M: [0, ACROSS_M] });
    const result = cell.computeScanImpedance({
      frequencyMHz: FREQUENCY_MHZ,
      scanDirection: { thetaDeg, phiDeg },
    });
    return result.impedance.real[0];
  } finally {
    cell.dispose();
  }
}

/** Stark's eq. (20), or without the image term of eq. (11) in free space. */
function starkResistance({ ground, thetaDeg, phiDeg }) {
  const theta = (thetaDeg * Math.PI) / 180;
  const phi = (phiDeg * Math.PI) / 180;
  const cosNormal = Math.cos(theta);
  const cosAlong = Math.sin(theta) * Math.cos(phi);
  const element = (Math.cos((Math.PI / 2) * cosAlong) / Math.sqrt(1 - cosAlong * cosAlong)) ** 2;
  const broadside = ground
    ? (120 / Math.PI) * Math.sin(2 * Math.PI * HEIGHT_M * cosNormal) ** 2
    : 60 / Math.PI;
  return (broadside / (ALONG_M * ACROSS_M)) * (element / cosNormal);
}

// [plane, phiDeg, thetaDeg, tolerance over ground, tolerance in free space] on
// the scanning factor R(theta) / R(0). Measured over ground (free space):
// E 20: 0.9 % (0.1), E 35: 2.3 % (0.1), H 20: 1.4 % (0.4), H 40: 6.4 % (1.9),
// D 20: 1.1 % (0.1), D 40: 4.1 % (0.4).
const SCAN_POINTS = [
  ["E", 0, 20, 0.02, 0.01],
  ["E", 0, 35, 0.04, 0.01],
  ["H", 90, 20, 0.03, 0.01],
  ["H", 90, 40, 0.08, 0.03],
  ["D", 45, 20, 0.02, 0.01],
  ["D", 45, 40, 0.06, 0.01],
];

for (const ground of [true, false]) {
  const setting = ground ? "a quarter wavelength over perfect ground" : "in free space";
  test(`scan resistance of half-wave dipoles ${setting} follows Stark's eq. (20)`, {
    skip,
    timeout: 120_000,
  }, async () => {
    const broadside = await scanResistance({ ground, thetaDeg: 0, phiDeg: 0 });
    const starkBroadside = starkResistance({ ground, thetaDeg: 0, phiDeg: 0 });
    // Measured 3.1 % over ground (131.3 against 127.3 ohm), 3.3 % in free space.
    const broadsideError = broadside / starkBroadside - 1;
    assert.ok(Math.abs(broadsideError) < 0.05, `broadside ${broadside}, Stark ${starkBroadside}`);

    for (const [plane, phiDeg, thetaDeg, groundTolerance, freeTolerance] of SCAN_POINTS) {
      const resistance = await scanResistance({ ground, thetaDeg, phiDeg });
      const scanningFactor = resistance / broadside;
      const starkFactor = starkResistance({ ground, thetaDeg, phiDeg }) / starkBroadside;
      const error = scanningFactor / starkFactor - 1;
      const tolerance = ground ? groundTolerance : freeTolerance;
      assert.ok(
        Math.abs(error) < tolerance,
        `${plane}-plane ${thetaDeg} deg: SF ${scanningFactor}, Stark ${starkFactor}, relative ${error}`,
      );
    }
  });
}
