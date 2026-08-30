import {
  NecStateError,
  abiVersion,
  createNecModel,
  engineVersion,
  packageVersion,
  rotationalOrder,
  runDeck,
  type GeometryCompletionResult,
  type GeometrySymmetry,
  type SymmetryCopy,
  type SymmetryFailureClassification,
  type ComplexMatrix,
  type FarFieldResult,
  type PortSolution,
} from "../src/index.js";

async function validConsumer(): Promise<void> {
  const model = await createNecModel();
  model.addWire({
    tag: 1,
    segments: 11,
    start: [0, 0, -0.25],
    end: [0, 0, 0.25],
    radiusM: 0.001,
  });
  const completion: GeometryCompletionResult = model.completeGeometry();
  completion.symmetry?.copies[0]?.transform.kind;
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

  packageVersion satisfies string;
  engineVersion satisfies string;
  abiVersion satisfies 1;

  const deck = await runDeck("CE\nEN\n");
  deck.report.toUpperCase();
}

void validConsumer;

const validSymmetries: readonly GeometrySymmetry[] = [
  {
    kind: "reflection",
    planes: ["x=0", "y=0"],
    tagIncrement: 4,
  },
  {
    kind: "rotational",
    axis: "z",
    order: rotationalOrder(4),
    tagIncrement: 4,
  },
];

const validCopies: readonly SymmetryCopy[] = [
  {
    index: 0,
    tagOffset: 0,
    transform: { kind: "cartesian-signs", signs: [1, 1, 1] },
  },
  {
    index: 1,
    tagOffset: 4,
    transform: { kind: "rotate-z", angleDeg: 90 },
  },
];

void validSymmetries;
void validCopies;

const validFailureClassifications: readonly SymmetryFailureClassification[] = [
  {
    reason: "INVALID_SYMMETRY",
    errorCode: "NEC_INPUT",
    representationEligibilityFailure: false,
  },
  {
    reason: "INCOMPATIBLE_GROUND",
    errorCode: "NEC_GEOMETRY",
    representationEligibilityFailure: true,
  },
  {
    reason: "INCOMPLETE_LOAD_ORBIT",
    errorCode: "NEC_GEOMETRY",
    representationEligibilityFailure: true,
  },
  {
    reason: "UNSUPPORTED_ELEMENT_PATTERN_TRANSFORM",
    errorCode: "NEC_GEOMETRY",
    representationEligibilityFailure: true,
  },
];

void validFailureClassifications;

async function validSymmetricCompletionConsumer(): Promise<void> {
  const model = await createNecModel();
  model.addWire({
    tag: 1,
    segments: 11,
    start: [0.25, 0.25, 0.1],
    end: [0.25, 0.25, 0.4],
    radiusM: 0.001,
  });
  const completion = model.completeGeometry({
    symmetry: validSymmetries[0]!,
  });
  completion.symmetry?.copies[0]?.tagOffset;
}

void validSymmetricCompletionConsumer;

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

  const emptyReflection: GeometrySymmetry = {
    kind: "reflection",
    // @ts-expect-error reflection symmetry requires at least one plane.
    planes: [],
    tagIncrement: 1,
  };

  const arbitraryAxis: GeometrySymmetry = {
    kind: "rotational",
    // @ts-expect-error the first contract supports only rotation about global Z.
    axis: "x",
    order: rotationalOrder(4),
    tagIncrement: 1,
  };

  const tooSmallOrder: GeometrySymmetry = {
    kind: "rotational",
    axis: "z",
    // @ts-expect-error raw values, including order 1, must pass rotationalOrder().
    order: 1,
    tagIncrement: 1,
  };

  const arbitraryPlane: GeometrySymmetry = {
    kind: "reflection",
    // @ts-expect-error only the three global coordinate planes are supported.
    planes: ["x=y"],
    tagIncrement: 1,
  };

  const unknownCopyTransform: SymmetryCopy = {
    index: 0,
    tagOffset: 0,
    // @ts-expect-error copy transform discriminants are closed.
    transform: { kind: "translate", offsetM: [1, 0, 0] },
  };

  // @ts-expect-error invalid descriptors are input errors, not geometry errors.
  const invalidFailureClassification: SymmetryFailureClassification = {
    reason: "INVALID_SYMMETRY",
    errorCode: "NEC_GEOMETRY",
    representationEligibilityFailure: false,
  };

  void emptyReflection;
  void arbitraryAxis;
  void tooSmallOrder;
  void arbitraryPlane;
  void unknownCopyTransform;
  void invalidFailureClassification;
}

void intentionallyInvalidConsumer;

const stateError = new NecStateError("solveCurrents", "geometry-complete");
stateError.code satisfies "NEC_STATE";
