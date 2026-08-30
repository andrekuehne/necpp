import { createNecModel } from "@necpp-engine/wasm";

const frequencyMHz = 300;
const wavelengthM = (1 / Math.sqrt(8.854e-12 * 4 * Math.PI * 1e-7))
  / (frequencyMHz * 1e6);
const model = await createNecModel();

try {
  // One positive-X/positive-Y element is the fundamental section of this 2 x 2 array.
  model.addWire({
    tag: 1,
    segments: 11,
    start: [wavelengthM / 4, wavelengthM / 4, wavelengthM / 12],
    end: [wavelengthM / 4, wavelengthM / 4, 5 * wavelengthM / 12],
    radiusM: wavelengthM / 1000,
  });
  const completion = model.completeGeometry({
    groundConnection: "none",
    symmetry: {
      kind: "reflection",
      planes: ["x=0", "y=0"],
      tagIncrement: 1,
    },
  });
  model.definePorts(Array.from(
    { length: 4 },
    (_, index) => ({ tag: index + 1, segment: 6 }),
  ));
  model.setGround({ kind: "perfect" });
  model.prepare({ frequencyMHz });
  const { impedance } = model.computeImpedanceMatrix();

  console.log(JSON.stringify({
    mode: "direct",
    sectionCount: completion.symmetry?.sectionCount,
    portCount: impedance.rows,
    finite: [...impedance.real, ...impedance.imag].every(Number.isFinite),
  }));
} finally {
  model.dispose();
}
