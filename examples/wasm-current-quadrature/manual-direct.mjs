import { createNecModel } from "@necpp-engine/wasm";

const model = await createNecModel();

try {
  model.addWire({
    tag: 1,
    segments: 11,
    start: [0, 0, -0.25],
    end: [0, 0, 0.25],
    radiusM: 0.001,
  });
  model.completeGeometry();
  model.definePorts([{ tag: 1, segment: 6, name: "feed" }]);
  model.prepare({ frequencyMHz: 300 });

  const characterization = model.characterizeIsolatedElement({
    quadrature: {
      nodes: Float64Array.of(-1, -1 / 3, 1 / 3, 1),
      images: "physical-only",
      modes: "unit-current",
    },
    field: {
      radiusM: 1,
      theta: { startDeg: 0, count: 5, stepDeg: 45 },
      phi: { startDeg: 0, count: 3, stepDeg: 90 },
    },
  });

  console.log(JSON.stringify({
    mode: "direct",
    zReal: characterization.impedance.real[0],
    zImag: characterization.impedance.imag[0],
    finiteZ: [...characterization.impedance.real, ...characterization.impedance.imag]
      .every(Number.isFinite),
    quadratureBytes: characterization.quadrature.byteLength,
    embeddedBytes: characterization.embeddedField.byteLength,
  }));
} finally {
  model.dispose();
}
