import {
  NecStateError,
  createNecModel,
  runDeck,
  type ComplexMatrix,
  type FarFieldResult,
  type PortSolution,
} from "../src/index.ts";

async function validConsumer(): Promise<void> {
  const model = await createNecModel();
  model.addWire({
    tag: 1,
    segments: 11,
    start: [0, 0, -0.25],
    end: [0, 0, 0.25],
    radiusM: 0.001,
  });
  model.completeGeometry();
  model.definePorts([{ tag: 1, segment: 6, name: "feed" }]);
  model.addLoad({
    kind: "impedance",
    target: { tag: 1, firstSegment: 1, lastSegment: 1 },
    resistanceOhm: 5,
    reactanceOhm: 2,
  });
  model.setGround({ kind: "free-space" });
  model.prepare({ frequencyMHz: 300 });

  const matrices: ComplexMatrix = model.computeImpedanceMatrix().impedance;
  const solution: PortSolution = model.solveCurrents({
    real: new Float64Array([1]),
    imag: new Float64Array([0]),
  });
  const field: FarFieldResult = model.computeFarField({
    radiusM: 1,
    theta: { startDeg: 0, count: 181, stepDeg: 1 },
    phi: { startDeg: 0, count: 361, stepDeg: 1 },
  });

  matrices.real[0];
  solution.currents.imag[0];
  field.eThetaReal[0];
  model.dispose();

  const deck = await runDeck("CE\nEN\n");
  deck.report.toUpperCase();
}

void validConsumer;

async function intentionallyInvalidConsumer(): Promise<void> {
  const model = await createNecModel();

  // @ts-expect-error radiusM is measured as a number of metres.
  model.addWire({ tag: 1, segments: 11, start: [0, 0, 0], end: [0, 0, 1], radiusM: "1 mm" });

  // @ts-expect-error complex parts must be Float64Array instances.
  model.solveVoltages({ real: [1], imag: [0] });

  // @ts-expect-error theta count is required.
  model.computeFarField({ theta: { startDeg: 0, stepDeg: 1 }, phi: { startDeg: 0, count: 1, stepDeg: 0 } });

  // @ts-expect-error the public model has no raw WASM pointer.
  model.handle;
}

void intentionallyInvalidConsumer;

const stateError = new NecStateError("solveCurrents", "geometry-complete");
stateError.code satisfies "NEC_STATE";
