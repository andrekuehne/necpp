import {
  centeredRectangularLattice,
  createNecPeriodicModel,
  hexagonalLattice,
  rectangularLattice,
  scanPhasesForDirection,
  squareLattice,
  terminatedFloquetAmplitudes,
  windowedArray,
  type ApproximateActiveImpedance,
  type ComplexMatrix,
  type ComplexVector,
  type DielectricLayer,
  type FarFieldResult,
  type FloquetAmplitudes,
  type FloquetMode,
  type FloquetPortPower,
  type LayeredStack,
  type LayeredStackDiagnostics,
  type LayeredStacks,
  type NecPeriodicModel,
  type PeriodicGround,
  type PeriodicLattice,
  type PeriodicPointDiagnostics,
  type PeriodicPointStatus,
  type ScanDirection,
  type ScanElementPattern,
  type ScanElementPatternSample,
  type ScanElementPatternValue,
  type ScanImpedanceResult,
  type ScanPhasesRad,
  type ScanState,
  type ScanSweepChunk,
  type ScanSweepPoint,
  type TerminatedFloquetAmplitudes,
  type WindowedArray,
  type WindowedArrayCell,
} from "../src/index.js";
import {
  createNecPeriodicWorkerModel,
  hexagonalLattice as workerHexagonalLattice,
  type NecPeriodicWorkerModel,
} from "../src/worker.js";

export async function periodicModelTypes(): Promise<void> {
  const cell: NecPeriodicModel = await createNecPeriodicModel();
  cell.addWire({ tag: 1, segments: 11, start: [-0.24, 0, 0], end: [0.24, 0, 0], radiusM: 0.001 });
  cell.completeGeometry();
  cell.definePorts([{ tag: 1, segment: 6 }]);

  const lattice: PeriodicLattice = { a1M: [0.7, 0], a2M: [0, 0.7] };
  cell.setLattice(lattice);
  // @ts-expect-error lattice vectors lie in the xy-plane.
  cell.setLattice({ a1M: [0.7, 0, 0], a2M: [0, 0.7] });

  const phases: ScanPhasesRad = [0.5, -0.25];
  const result: ScanImpedanceResult = cell.computeScanImpedance({
    frequencyMHz: 300,
    scanPhasesRad: phases,
  });
  const impedance: ComplexMatrix = result.impedance;
  const admittance: ComplexMatrix = result.admittance;
  const echoed: ScanPhasesRad = result.scanPhasesRad;
  void impedance;
  void admittance;
  void echoed;

  // Presets return plain lattice vectors; there is no lattice-type field.
  const presets: readonly PeriodicLattice[] = [
    squareLattice({ spacingM: 0.5 }),
    rectangularLattice({ spacingXM: 0.6, spacingYM: 0.5 }),
    centeredRectangularLattice({ spacingXM: 0.7, spacingYM: 0.45 }),
    hexagonalLattice({ spacingM: 0.6 }),
    hexagonalLattice({ spacingM: 0.6, rowsAlong: "y" }),
  ];
  for (const preset of presets) {
    cell.setLattice(preset);
  }
  // @ts-expect-error hexagonal rows run along x or y only.
  hexagonalLattice({ spacingM: 0.6, rowsAlong: "z" });

  const direction: ScanDirection = { thetaDeg: 30, phiDeg: 45 };
  const steered: ScanImpedanceResult = cell.computeScanImpedance({
    frequencyMHz: 300,
    scanDirection: direction,
  });
  const solvedPhases: ScanPhasesRad = steered.scanPhasesRad;
  const mapped: ScanPhasesRad = scanPhasesForDirection({
    lattice,
    frequencyMHz: 300,
    ...direction,
  });
  void solvedPhases;
  void mapped;
  // @ts-expect-error a scan state is either scan phases or a scan direction, not both.
  cell.computeScanImpedance({ frequencyMHz: 300, scanPhasesRad: phases, scanDirection: direction });
  // @ts-expect-error a scan state is required.
  cell.computeScanImpedance({ frequencyMHz: 300 });

  // One fixed internal tolerance: every result carries its estimated error and
  // point status, and nothing numerical can be tuned.
  const diagnostics: PeriodicPointDiagnostics = result.diagnostics;
  const estimatedError: number = diagnostics.estimatedError;
  const status: PeriodicPointStatus = diagnostics.status;
  // On or near a Wood anomaly a result is flagged, never refused or NaN.
  const statuses: readonly PeriodicPointStatus[] = ["ok", "near-cutoff"];
  // @ts-expect-error there is no refused or failed point status.
  const refused: PeriodicPointStatus = "refused";
  void estimatedError;
  void status;
  void statuses;
  void refused;
  // @ts-expect-error diagnostics are read-only.
  result.diagnostics.estimatedError = 0;
  // @ts-expect-error no tolerance in a scan request.
  cell.computeScanImpedance({ frequencyMHz: 300, scanPhasesRad: phases, tolerance: 1e-3 });
  // @ts-expect-error no Ewald splitting in a scan request.
  cell.computeScanImpedance({ frequencyMHz: 300, scanPhasesRad: phases, ewaldSplitting: 2 });
  // @ts-expect-error no Floquet-mode truncation in a scan request.
  cell.computeScanImpedance({ frequencyMHz: 300, scanDirection: direction, floquetModes: 50 });
  // @ts-expect-error no numerical options with the lattice.
  cell.setLattice({ ...lattice, imageReachM: 0.1 });
  // @ts-expect-error no accuracy setting on the periodic model.
  void cell.setTolerance;

  // Wires only: there are no surface patches, networks or transmission lines.
  // @ts-expect-error no surface patches on the periodic model.
  void cell.addPatch;
  // @ts-expect-error no networks on the periodic model.
  void cell.addNetwork;
  // @ts-expect-error no transmission lines on the periodic model.
  void cell.addTransmissionLine;

  // A single cell of an infinite array has no far field of its own.
  // @ts-expect-error no far fields on the periodic model.
  void cell.computeFarField;
  // @ts-expect-error no embedded far fields on the periodic model.
  void cell.computeEmbeddedFarFields;
  // @ts-expect-error no isolated-element (ring-field) characterization on the periodic model.
  void cell.characterizeIsolatedElement;
  // Free space or perfect ground; finite ground needs layered stacks.
  const ground: PeriodicGround = { kind: "perfect" };
  cell.setGround(ground);
  cell.setGround({ kind: "free-space" });
  cell.setGround(
    // @ts-expect-error no finite ground on the periodic model.
    { kind: "finite", method: "reflection-coefficient", relativePermittivity: 13, conductivitySPerM: 0.005 },
  );
  // @ts-expect-error unit cells take no symmetry options.
  cell.completeGeometry({ symmetry: { kind: "reflection", planes: ["x=0"], tagIncrement: 10 } });

  cell.dispose();
}

export function periodicFloquetTypes(cell: NecPeriodicModel): void {
  const result = cell.computeScanImpedance({
    frequencyMHz: 300,
    scanPhasesRad: [0, 0],
    normalization: { kind: "unit-current", valueA: 1 },
    evanescentModes: [{ p: 1, q: 0 }],
  });
  const floquet: FloquetAmplitudes = result.floquet;
  const mode: FloquetMode | undefined = floquet.modes[0];
  const side: "above" | "below" | undefined = mode?.side;
  const te: ComplexVector | undefined = mode?.te;
  const kz: readonly [number, number] | undefined = mode?.kzRadPerM;
  const budget: FloquetPortPower | undefined = floquet.powerBudget[0];
  void side;
  void te;
  void kz;
  void budget;
  // @ts-expect-error amplitudes are read-only.
  floquet.modes = [];
  // @ts-expect-error a mode index is a pair of integers p, q.
  cell.computeScanImpedance({ frequencyMHz: 300, scanPhasesRad: [0, 0], evanescentModes: [[1, 0]] });
  // @ts-expect-error the normalization is the embedded-field one.
  cell.computeScanImpedance({ frequencyMHz: 300, scanPhasesRad: [0, 0], normalization: "unit-current" });

  const terminated: TerminatedFloquetAmplitudes = terminatedFloquetAmplitudes(result, {
    generatorImpedanceOhm: [50, 20],
  });
  terminatedFloquetAmplitudes(result, { generatorImpedanceOhm: 50 });
  const generator: readonly [number, number] = terminated.generatorImpedanceOhm;
  void generator;
  // @ts-expect-error the generator impedance is required.
  terminatedFloquetAmplitudes(result, {});
  cell.sweepScanImpedance({
    frequencyMHz: 300,
    scanStates: [{ scanPhasesRad: [0, 0] }],
    normalization: { kind: "unit-voltage", valueV: 1 },
  });
}

export async function periodicSweepTypes(cell: NecPeriodicModel): Promise<void> {
  const states: readonly ScanState[] = [
    { scanPhasesRad: [0, 0] },
    { scanDirection: { thetaDeg: 30, phiDeg: 0 } },
  ];
  const controller = new AbortController();
  for await (const chunk of cell.sweepScanImpedance(
    { frequencyMHz: 300, scanStates: states },
    { workers: 2, signal: controller.signal },
  )) {
    const typed: ScanSweepChunk = chunk;
    const point: ScanSweepPoint | undefined = typed.points[0];
    const index: number | undefined = point?.index;
    const result: ScanImpedanceResult | undefined = point?.result;
    const progress: number = typed.completed / typed.total;
    void index;
    void result;
    void progress;
  }
  cell.sweepScanImpedance({ frequencyMHz: 300, scanStates: states }, { workers: "auto" });
  // @ts-expect-error a scan state is either scan phases or a scan direction, not both.
  cell.sweepScanImpedance({ frequencyMHz: 300, scanStates: [{ scanPhasesRad: [0, 0], scanDirection: { thetaDeg: 0, phiDeg: 0 } }] });
  // @ts-expect-error the frequency is fixed for the whole sweep, not per scan state.
  cell.sweepScanImpedance({ scanStates: [{ frequencyMHz: 300, scanPhasesRad: [0, 0] }] });
  // @ts-expect-error no chunk-size or tolerance knob.
  cell.sweepScanImpedance({ frequencyMHz: 300, scanStates: states }, { chunkSize: 4 });
}

export async function periodicWorkerTypes(): Promise<void> {
  const cell: NecPeriodicWorkerModel = await createNecPeriodicWorkerModel({ onProgress: () => undefined });
  await cell.addWire({ tag: 1, segments: 11, start: [-0.24, 0, 0.2], end: [0.24, 0, 0.2], radiusM: 0.001 });
  await cell.completeGeometry();
  await cell.definePorts([{ tag: 1, segment: 6 }]);
  await cell.setGround({ kind: "perfect" });
  await cell.setLattice(workerHexagonalLattice({ spacingM: 0.6 }));
  const result: ScanImpedanceResult = await cell.computeScanImpedance({ frequencyMHz: 300, scanPhasesRad: [0, 0] });
  void result;
  const chunks: AsyncIterable<ScanSweepChunk> = cell.sweepScanImpedance({
    frequencyMHz: 300,
    scanStates: [{ scanPhasesRad: [0, 0] }],
  });
  void chunks;
  // @ts-expect-error worker methods are asynchronous.
  const synchronous: ScanImpedanceResult = cell.computeScanImpedance({ frequencyMHz: 300, scanPhasesRad: [0, 0] });
  void synchronous;
  // @ts-expect-error no far fields on the periodic worker model.
  void cell.computeFarField;
  // @ts-expect-error no embedded far fields on the periodic worker model.
  void cell.computeEmbeddedFarFields;
  // @ts-expect-error no isolated-element characterization on the periodic worker model.
  void cell.characterizeIsolatedElement;
  // @ts-expect-error no prepare step: the scan request names the frequency.
  void cell.prepare;
  cell.setGround(
    // @ts-expect-error no finite ground on the periodic worker model.
    { kind: "finite", method: "reflection-coefficient", relativePermittivity: 13, conductivitySPerM: 0.005 },
  );
  cell.terminate();
  await cell.dispose();
}

export async function scanElementPatternTypes(cell: NecPeriodicModel, worker: NecPeriodicWorkerModel): Promise<void> {
  const pattern: ScanElementPattern = await cell.computeScanElementPattern(
    {
      frequencyMHz: 300,
      normalization: { kind: "unit-current", valueA: 1 },
      grid: { spacingUV: 0.05, points: [{ u: 0.1, v: 0.2 }] },
      refinement: { tolerance: 0.005, maxRounds: 2, maxSamples: 10_000 },
    },
    { workers: 4, onProgress: ({ completed, total, round }) => void [completed, total, round] },
  );
  await cell.computeScanElementPattern({ frequencyMHz: 300, grid: "auto", refinement: false });
  const value: ScanElementPatternValue = pattern.evaluate({ u: 0.3, v: -0.2 });
  const below: ScanElementPatternValue = pattern.evaluate({ thetaDeg: 30, phiDeg: 90 }, "below");
  const te: ComplexVector = value.te;
  const error: Float64Array = below.interpolationError;
  const sample: ScanElementPatternSample | undefined = pattern.samples[0];
  const round: number | undefined = sample?.round;
  const centre: readonly [number, number] | undefined = pattern.woodCircles[0]?.centreUV;
  void [te, error, round, centre];
  // @ts-expect-error a direction is (u, v) or angles, not a pair.
  pattern.evaluate([0.3, -0.2]);
  // @ts-expect-error the side is "above" or "below".
  pattern.evaluate({ u: 0, v: 0 }, "upper");
  // @ts-expect-error samples are read-only.
  pattern.samples = [];
  // @ts-expect-error a grid is "auto" or { spacingUV?, points? }.
  void cell.computeScanElementPattern({ frequencyMHz: 300, grid: "fine" });
  // @ts-expect-error refinement is off with false, not true.
  void cell.computeScanElementPattern({ frequencyMHz: 300, refinement: true });
  const fromWorker: Promise<ScanElementPattern> = worker.computeScanElementPattern({ frequencyMHz: 300 });
  void fromWorker;
}

export function windowedArrayTypes(pattern: ScanElementPattern, steering: ScanImpedanceResult): void {
  const lattice: PeriodicLattice = pattern.lattice;
  const cells: WindowedArrayCell[] = [[0, 0], [1, 0], [0, 1]];
  const array: WindowedArray = windowedArray(pattern, {
    steering,
    cells,
    excitation: { real: new Float64Array(3), imag: new Float64Array(3) },
  });
  windowedArray(pattern, { steering, cells });
  const field: FarFieldResult = array.computeFarField({
    radiusM: 10,
    theta: { startDeg: -90, count: 181, stepDeg: 1 },
    phi: { startDeg: 0, count: 1, stepDeg: 0 },
  });
  const impedances: ApproximateActiveImpedance = array.activeImpedances;
  const approximate: true = impedances.approximate;
  const drive: ComplexVector = array.drive;
  void [lattice, field, approximate, drive];
  // @ts-expect-error the steering state is a scan result, not a direction.
  windowedArray(pattern, { steering: { thetaDeg: 30, phiDeg: 0 }, cells });
  // @ts-expect-error a cell is a pair of lattice indices.
  windowedArray(pattern, { steering, cells: [{ m: 0, n: 0 }] });
  // @ts-expect-error the windowed array has no ring or other field evaluator.
  array.computeFarField({ evaluator: "ring", theta: { startDeg: 0, count: 1, stepDeg: 0 }, phi: { startDeg: 0, count: 1, stepDeg: 0 } });
}

export async function layeredStackTypes(
  cell: NecPeriodicModel,
  worker: NecPeriodicWorkerModel,
  result: ScanImpedanceResult,
): Promise<void> {
  const layer: DielectricLayer = { thicknessM: 0.003, relativePermittivity: 4, lossTangent: 0.02 };
  const above: LayeredStack = { bottomZM: 0.04, layers: [layer, { thicknessM: 0.01, relativePermittivity: 2.2 }] };
  const stacks: LayeredStacks = { above };
  cell.setLayeredStacks(stacks);
  cell.setLayeredStacks({});
  await worker.setLayeredStacks(stacks);
  const diagnostics: LayeredStackDiagnostics | undefined = result.diagnostics.layeredStack;
  const loss: number = result.floquet.powerBudget[0]!.dielectricLossW;
  void [diagnostics, loss];
  // @ts-expect-error only a stack above the wires is supported.
  cell.setLayeredStacks({ below: above });
  // @ts-expect-error a layer needs its thickness.
  cell.setLayeredStacks({ above: { bottomZM: 0.04, layers: [{ relativePermittivity: 4 }] } });
}
