import {
  NecStateError,
  abiVersion,
  createNecWorkerModel,
  engineVersion,
  packageVersion,
  rotationalOrder,
  type GeometryCompletionResult,
  type ComplexMatrix,
  type FarFieldResult,
  type NecWorkerProgressEvent,
  type PortSolution,
} from "../src/worker.js";

async function validWorkerConsumer(): Promise<void> {
  const events: NecWorkerProgressEvent[] = [];
  const model = await createNecWorkerModel({
    onProgress(event) {
      events.push(event);
    },
  });

  await model.addWire({
    tag: 1,
    segments: 11,
    start: [0, 0, -0.25],
    end: [0, 0, 0.25],
    radiusM: 0.001,
  });
  const completion: GeometryCompletionResult = await model.completeGeometry();
  completion.symmetry?.sectionCount;
  await model.definePorts([{ tag: 1, segment: 6, name: "feed" }]);
  await model.prepare({ frequencyMHz: 300 });

  const matrices: ComplexMatrix = (await model.computeImpedanceMatrix()).impedance;
  const solution: PortSolution = await model.solveCurrents({
    real: new Float64Array([1]),
    imag: new Float64Array([0]),
  });
  const field: FarFieldResult = await model.computeFarField({
    radiusM: 1,
    theta: { startDeg: 0, count: 3, stepDeg: 45 },
    phi: { startDeg: 0, count: 2, stepDeg: 90 },
  });

  matrices.real[0];
  solution.currents.imag[0];
  field.eThetaReal[0];
  events[0]?.operation;

  const unsubscribe = model.subscribeProgress(() => undefined);
  unsubscribe();
  await model.dispose();
  model.terminate();

  packageVersion satisfies string;
  engineVersion satisfies string;
  abiVersion satisfies 1;
}

void validWorkerConsumer;

async function intentionallyInvalidWorkerConsumer(): Promise<void> {
  const model = await createNecWorkerModel();

  // @ts-expect-error worker methods return promises, not void.
  const added: void = model.addWire({
    tag: 1,
    segments: 11,
    start: [0, 0, -0.25],
    end: [0, 0, 0.25],
    radiusM: 0.001,
  });

  // @ts-expect-error worker models do not expose a raw WASM handle.
  model.handle;

  // @ts-expect-error progress callbacks are not a createNecModel option mix-in on the model.
  model.onProgress;

  await model.completeGeometry({
    symmetry: {
      kind: "rotational",
      axis: "z",
      order: rotationalOrder(4),
      tagIncrement: 1,
    },
  });
}

void intentionallyInvalidWorkerConsumer;

const stateError = new NecStateError("computeImpedanceMatrix", "disposed");
stateError.code satisfies "NEC_STATE";
