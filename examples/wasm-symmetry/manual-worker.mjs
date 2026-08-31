import { createNecWorkerModel } from "@necpp-engine/wasm/worker";

const frequencyMHz = 300;
const wavelengthM = (1 / Math.sqrt(8.854e-12 * 4 * Math.PI * 1e-7))
  / (frequencyMHz * 1e6);
const model = await createNecWorkerModel();

try {
  // Worker methods have the same manual descriptor and metadata, but are asynchronous.
  await model.addWire({
    tag: 1,
    segments: 11,
    start: [wavelengthM / 4, wavelengthM / 4, wavelengthM / 12],
    end: [wavelengthM / 4, wavelengthM / 4, 5 * wavelengthM / 12],
    radiusM: wavelengthM / 1000,
  });
  const completion = await model.completeGeometry({
    groundConnection: "none",
    symmetry: {
      kind: "reflection",
      planes: ["x=0", "y=0"],
      tagIncrement: 1,
    },
  });
  await model.definePorts(Array.from(
    { length: 4 },
    (_, index) => ({ tag: index + 1, segment: 6 }),
  ));
  await model.setGround({ kind: "perfect" });
  await model.prepare({ frequencyMHz });
  const { impedance } = await model.computeImpedanceMatrix();

  console.log(JSON.stringify({
    mode: "worker",
    sectionCount: completion.symmetry?.sectionCount,
    portCount: impedance.rows,
    finite: [...impedance.real, ...impedance.imag].every(Number.isFinite),
  }));
} finally {
  await model.dispose();
}
