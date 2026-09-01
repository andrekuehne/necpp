import {
  analyzeArraySymmetry,
  createExplicitArrayBuildPlan,
} from "./array-symmetry.js";
import { NecError, NecGeometryError, NecInputError } from "./errors.js";
import { createNecArrayWorkerModel } from "./worker-client.js";
import type {
  ArrayBuildPlan,
  ArraySolverDiagnostics,
  ComplexMatrix,
  ComplexVector,
  CreateArraySolverOptions,
  ElementWirePattern,
  EmbeddedFarFieldResult,
  EmbeddedFieldNormalization,
  FarFieldRequest,
  FarFieldResult,
  FieldBackendDiagnostics,
  FieldWorkerSelection,
  FullArrayDescription,
  GeometryCompletionResult,
  ImpedanceResult,
  LoadDefinition,
  NecArraySolver,
  NecModel,
  NecModelState,
  NecWorkerModel,
  PortDefinition,
  PortSolution,
  PrepareOptions,
  RelativeLoadDefinition,
  SymmetrizationReason,
  SymmetrizationReasonCode,
  SymmetryFailureReason,
} from "./types.js";

const NEC_VACUUM_PERMITTIVITY_F_PER_M = 8.854e-12;
const NEC_VACUUM_PERMEABILITY_H_PER_M = 4 * Math.PI * 1e-7;
const NEC_SPEED_OF_LIGHT_M_PER_S = 1 / Math.sqrt(
  NEC_VACUUM_PERMITTIVITY_F_PER_M * NEC_VACUUM_PERMEABILITY_H_PER_M,
);

type ArrayModel = NecModel | NecWorkerModel;

export interface AppliedArrayBuildPlan {
  readonly completion: GeometryCompletionResult;
  readonly callerPorts: readonly PortDefinition[];
  /** Caller-order port index to the native model's port order. */
  readonly scatterCallerToNative: readonly number[];
}

interface ElementAllocation {
  readonly pattern: ElementWirePattern;
  readonly wireTags: ReadonlyMap<string, number>;
}

async function invoke<T>(value: T | Promise<T>): Promise<T> {
  return Promise.resolve(value);
}

function patternsById(description: FullArrayDescription): ReadonlyMap<string, ElementWirePattern> {
  return new Map(description.patterns.map((pattern) => [pattern.id, pattern]));
}

function allocateCallerModel(description: FullArrayDescription): {
  readonly allocations: readonly ElementAllocation[];
  readonly ports: readonly PortDefinition[];
} {
  const patterns = patternsById(description);
  const allocations: ElementAllocation[] = [];
  const ports: PortDefinition[] = [];
  let nextTag = 1;
  for (const element of description.elements) {
    const pattern = patterns.get(element.patternId);
    if (pattern === undefined) {
      throw new NecInputError(`Unknown pattern ${element.patternId}`);
    }
    const wireTags = new Map<string, number>();
    for (const wire of pattern.wires) {
      wireTags.set(wire.id, nextTag);
      nextTag += 1;
    }
    for (const port of pattern.ports) {
      const tag = wireTags.get(port.wireId)!;
      ports.push(Object.freeze(port.name === undefined
        ? { tag, segment: port.segment }
        : { tag, segment: port.segment, name: port.name }));
    }
    allocations.push(Object.freeze({ pattern, wireTags }));
  }
  return Object.freeze({
    allocations: Object.freeze(allocations),
    ports: Object.freeze(ports),
  });
}

function retargetLoad(load: RelativeLoadDefinition, tag: number): LoadDefinition {
  return {
    ...load,
    target: {
      tag,
      ...(load.target.firstSegment === undefined
        ? {}
        : { firstSegment: load.target.firstSegment }),
      ...(load.target.lastSegment === undefined
        ? {}
        : { lastSegment: load.target.lastSegment }),
    },
  } as LoadDefinition;
}

async function addElementWires(
  model: ArrayModel,
  pattern: ElementWirePattern,
  positionM: readonly [number, number],
  wireTags: ReadonlyMap<string, number>,
  rotationDeg = 0,
): Promise<void> {
  const angle = rotationDeg * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const rotate = (x: number, y: number): readonly [number, number] => [
    cosine * x - sine * y,
    sine * x + cosine * y,
  ];
  for (const wire of pattern.wires) {
    const start = rotate(wire.startM[0], wire.startM[1]);
    const end = rotate(wire.endM[0], wire.endM[1]);
    await invoke(model.addWire({
      tag: wireTags.get(wire.id)!,
      segments: wire.segments,
      start: [
        positionM[0] + start[0],
        positionM[1] + start[1],
        wire.startM[2],
      ],
      end: [
        positionM[0] + end[0],
        positionM[1] + end[1],
        wire.endM[2],
      ],
      radiusM: wire.radiusM,
    }));
  }
}

async function applyExplicit(
  model: ArrayModel,
  description: FullArrayDescription,
  plan: Extract<ArrayBuildPlan, { readonly kind: "explicit" }>,
  caller: ReturnType<typeof allocateCallerModel>,
): Promise<AppliedArrayBuildPlan> {
  for (let index = 0; index < plan.elements.length; index += 1) {
    const allocation = caller.allocations[index]!;
    await addElementWires(
      model,
      allocation.pattern,
      plan.elements[index]!.positionM,
      allocation.wireTags,
      description.elements[index]!.rotationDeg ?? 0,
    );
  }
  const completion = await invoke(model.completeGeometry({
    groundConnection: description.groundConnection ?? "none",
  }));
  await invoke(model.definePorts(caller.ports));
  for (const allocation of caller.allocations) {
    for (const load of allocation.pattern.loads ?? []) {
      await invoke(model.addLoad(retargetLoad(load, allocation.wireTags.get(load.target.wireId)!)));
    }
  }
  await invoke(model.setGround(description.ground));
  return Object.freeze({
    completion,
    callerPorts: caller.ports,
    scatterCallerToNative: Object.freeze(Array.from(
      { length: caller.ports.length },
      (_, index) => index,
    )),
  });
}

async function applySymmetric(
  model: ArrayModel,
  description: FullArrayDescription,
  plan: Extract<ArrayBuildPlan, { readonly kind: "symmetric" }>,
  caller: ReturnType<typeof allocateCallerModel>,
): Promise<AppliedArrayBuildPlan> {
  const patterns = patternsById(description);
  const fundamentalAllocations: ElementAllocation[] = [];
  let nextTag = 1;
  for (const element of plan.fundamentalElements) {
    const pattern = patterns.get(element.patternId)!;
    const wireTags = new Map<string, number>();
    for (const wire of pattern.wires) {
      wireTags.set(wire.id, nextTag);
      nextTag += 1;
    }
    fundamentalAllocations.push(Object.freeze({ pattern, wireTags }));
    await addElementWires(model, pattern, element.positionM, wireTags);
  }
  const completion = await invoke(model.completeGeometry({
    groundConnection: description.groundConnection ?? "none",
    symmetry: plan.symmetry,
  }));
  const nativePorts: PortDefinition[] = [];
  for (const copy of plan.expansion.copies) {
    for (const allocation of fundamentalAllocations) {
      for (const port of allocation.pattern.ports) {
        const tag = allocation.wireTags.get(port.wireId)! + copy.tagOffset;
        nativePorts.push(port.name === undefined
          ? { tag, segment: port.segment }
          : { tag, segment: port.segment, name: port.name });
      }
    }
  }
  await invoke(model.definePorts(nativePorts));
  // Loads are structural. Expand every fundamental load atomically over all
  // native copies so prepare never observes an incomplete orbit.
  for (const copy of plan.expansion.copies) {
    for (const allocation of fundamentalAllocations) {
      for (const load of allocation.pattern.loads ?? []) {
        const tag = allocation.wireTags.get(load.target.wireId)! + copy.tagOffset;
        await invoke(model.addLoad(retargetLoad(load, tag)));
      }
    }
  }
  await invoke(model.setGround(description.ground));
  const scatter = new Array<number>(caller.ports.length);
  for (const mapping of plan.mappings) {
    for (let portIndex = 0; portIndex < mapping.callerPortIndices.length; portIndex += 1) {
      scatter[mapping.callerPortIndices[portIndex]!] = mapping.generatedPortIndices[portIndex]!;
    }
  }
  if (scatter.some((index) => !Number.isSafeInteger(index))) {
    throw new NecGeometryError("Symmetry plan does not map every caller port");
  }
  return Object.freeze({
    completion,
    callerPorts: caller.ports,
    scatterCallerToNative: Object.freeze(scatter),
  });
}

/** Apply a validated planner result to either a direct or worker model. */
export async function applyArrayBuildPlan(
  model: ArrayModel,
  description: FullArrayDescription,
  plan: ArrayBuildPlan,
): Promise<AppliedArrayBuildPlan> {
  const caller = allocateCallerModel(description);
  return plan.kind === "explicit"
    ? applyExplicit(model, description, plan, caller)
    : applySymmetric(model, description, plan, caller);
}

function validateVector(vector: ComplexVector, length: number): void {
  if (!(vector.real instanceof Float64Array) || !(vector.imag instanceof Float64Array)
    || vector.real.length !== length || vector.imag.length !== length) {
    throw new NecInputError(`Complex vector must contain ${length} real and imaginary values`);
  }
}

/** Scatter a caller-order vector into native port order. */
export function scatterComplexVector(
  vector: ComplexVector,
  scatterCallerToNative: readonly number[],
): ComplexVector {
  validateVector(vector, scatterCallerToNative.length);
  const real = new Float64Array(scatterCallerToNative.length);
  const imag = new Float64Array(scatterCallerToNative.length);
  for (let caller = 0; caller < scatterCallerToNative.length; caller += 1) {
    const native = scatterCallerToNative[caller]!;
    real[native] = vector.real[caller]!;
    imag[native] = vector.imag[caller]!;
  }
  return { real, imag };
}

/** Gather a native-order vector into caller port order. */
export function gatherComplexVector(
  vector: ComplexVector,
  scatterCallerToNative: readonly number[],
): ComplexVector {
  validateVector(vector, scatterCallerToNative.length);
  const real = new Float64Array(scatterCallerToNative.length);
  const imag = new Float64Array(scatterCallerToNative.length);
  for (let caller = 0; caller < scatterCallerToNative.length; caller += 1) {
    const native = scatterCallerToNative[caller]!;
    real[caller] = vector.real[native]!;
    imag[caller] = vector.imag[native]!;
  }
  return { real, imag };
}

/** Gather both dimensions of a native row-major matrix. */
export function gatherComplexMatrix(
  matrix: ComplexMatrix,
  scatterCallerToNative: readonly number[],
): ComplexMatrix {
  const order = scatterCallerToNative.length;
  if (matrix.rows !== order || matrix.columns !== order
    || matrix.real.length !== order * order || matrix.imag.length !== order * order) {
    throw new NecInputError(`Complex matrix must be ${order} by ${order}`);
  }
  const real = new Float64Array(order * order);
  const imag = new Float64Array(order * order);
  for (let row = 0; row < order; row += 1) {
    for (let column = 0; column < order; column += 1) {
      const source = scatterCallerToNative[row]! * order + scatterCallerToNative[column]!;
      const target = row * order + column;
      real[target] = matrix.real[source]!;
      imag[target] = matrix.imag[source]!;
    }
  }
  return { rows: order, columns: order, order: "row-major", real, imag };
}

/** Gather the basis-major outer port dimension of a field array. */
export function gatherEmbeddedBasis(
  values: Float64Array,
  samplesPerPort: number,
  scatterCallerToNative: readonly number[],
): Float64Array {
  if (values.length !== samplesPerPort * scatterCallerToNative.length) {
    throw new NecInputError("Embedded field array has an invalid basis dimension");
  }
  const gathered = new Float64Array(values.length);
  for (let caller = 0; caller < scatterCallerToNative.length; caller += 1) {
    const native = scatterCallerToNative[caller]!;
    gathered.set(
      values.subarray(native * samplesPerPort, (native + 1) * samplesPerPort),
      caller * samplesPerPort,
    );
  }
  return gathered;
}

function rephaseArrays(
  result: FarFieldResult,
  centerM: readonly [number, number],
  basisCount: number,
): Pick<FarFieldResult, "eThetaReal" | "eThetaImag" | "ePhiReal" | "ePhiImag"> {
  const samples = result.thetaDeg.length * result.phiDeg.length;
  const thetaReal = result.eThetaReal.slice();
  const thetaImag = result.eThetaImag.slice();
  const phiReal = result.ePhiReal.slice();
  const phiImag = result.ePhiImag.slice();
  if (centerM[0] === 0 && centerM[1] === 0) {
    return { eThetaReal: thetaReal, eThetaImag: thetaImag, ePhiReal: phiReal, ePhiImag: phiImag };
  }
  const waveNumber = 2 * Math.PI * result.frequencyMHz * 1e6 / NEC_SPEED_OF_LIGHT_M_PER_S;
  for (let basis = 0; basis < basisCount; basis += 1) {
    for (let phiIndex = 0; phiIndex < result.phiDeg.length; phiIndex += 1) {
      const phi = result.phiDeg[phiIndex]! * Math.PI / 180;
      for (let thetaIndex = 0; thetaIndex < result.thetaDeg.length; thetaIndex += 1) {
        const theta = result.thetaDeg[thetaIndex]! * Math.PI / 180;
        const phase = waveNumber * Math.sin(theta)
          * (Math.cos(phi) * centerM[0] + Math.sin(phi) * centerM[1]);
        const cosine = Math.cos(phase);
        const sine = Math.sin(phase);
        const index = basis * samples + phiIndex * result.thetaDeg.length + thetaIndex;
        for (const [real, imag] of [
          [thetaReal, thetaImag],
          [phiReal, phiImag],
        ] as const) {
          const originalReal = real[index]!;
          const originalImag = imag[index]!;
          real[index] = originalReal * cosine - originalImag * sine;
          imag[index] = originalReal * sine + originalImag * cosine;
        }
      }
    }
  }
  return { eThetaReal: thetaReal, eThetaImag: thetaImag, ePhiReal: phiReal, ePhiImag: phiImag };
}

/** Restore the far-zone phase removed by centering a symmetric XY model. */
export function rephaseFarField(
  result: FarFieldResult,
  centerM: readonly [number, number],
): FarFieldResult {
  return { ...result, ...rephaseArrays(result, centerM, 1) };
}

function failureReason(error: unknown): SymmetryFailureReason | undefined {
  if (!(error instanceof NecError)) {
    return undefined;
  }
  const value = error.details?.symmetryFailure;
  return value === "INCOMPATIBLE_GROUND"
    || value === "INCOMPLETE_LOAD_ORBIT"
    || value === "UNSUPPORTED_ELEMENT_PATTERN_TRANSFORM"
    ? value
    : undefined;
}

function retryReason(value: SymmetryFailureReason): SymmetrizationReason {
  const code: SymmetrizationReasonCode = value === "INCOMPATIBLE_GROUND"
    ? "GROUND_BREAKS_SYMMETRY"
    : value === "INCOMPLETE_LOAD_ORBIT"
      ? "UNSYMMETRIC_LOAD"
      : "UNSUPPORTED_ELEMENT_PATTERN_TRANSFORM";
  return Object.freeze({
    code,
    message: `Symmetric construction failed with ${value}; rebuilt the unchanged explicit model`,
  });
}

function explicitRetryPlan(
  description: FullArrayDescription,
  previous: ArrayBuildPlan,
  failure: SymmetryFailureReason,
): Extract<ArrayBuildPlan, { readonly kind: "explicit" }> {
  const base = createExplicitArrayBuildPlan(description);
  const reason = retryReason(failure);
  const reasons = Object.freeze([reason]);
  const diagnostics = Object.freeze({
    ...base.diagnostics,
    candidates: previous.diagnostics.candidates,
    reasons,
  });
  return Object.freeze({ ...base, reasons, diagnostics });
}

async function buildWorker(
  description: FullArrayDescription,
  plan: ArrayBuildPlan,
  fieldWorkers: FieldWorkerSelection,
  fieldWorkerAssetBaseUrl?: string,
): Promise<{ readonly model: NecWorkerModel; readonly application: AppliedArrayBuildPlan }> {
  const model = await createNecArrayWorkerModel({
    fieldWorkers,
    ...(fieldWorkerAssetBaseUrl === undefined ? {} : { fieldWorkerAssetBaseUrl }),
  });
  try {
    return { model, application: await applyArrayBuildPlan(model, description, plan) };
  } catch (error) {
    await model.dispose();
    throw error;
  }
}

class WorkerNecArraySolver implements NecArraySolver {
  #model: NecWorkerModel;
  #plan: ArrayBuildPlan;
  #application: AppliedArrayBuildPlan;
  readonly #description: FullArrayDescription;
  readonly #mode: "auto" | "off" | "require";
  readonly #fieldWorkers: FieldWorkerSelection;
  readonly #fieldWorkerAssetBaseUrl: string | undefined;
  #fieldDiagnostics: FieldBackendDiagnostics;
  #retried = false;

  constructor(
    model: NecWorkerModel,
    description: FullArrayDescription,
    plan: ArrayBuildPlan,
    application: AppliedArrayBuildPlan,
    mode: "auto" | "off" | "require",
    fieldWorkers: FieldWorkerSelection,
    fieldWorkerAssetBaseUrl?: string,
  ) {
    this.#model = model;
    this.#description = description;
    this.#plan = plan;
    this.#application = application;
    this.#mode = mode;
    this.#fieldWorkers = fieldWorkers;
    this.#fieldWorkerAssetBaseUrl = fieldWorkerAssetBaseUrl;
    this.#fieldDiagnostics = pendingFieldDiagnostics(fieldWorkers);
  }

  get state(): NecModelState {
    return this.#model.state;
  }

  async prepare(options: PrepareOptions): Promise<void> {
    try {
      await this.#model.prepare(options);
    } catch (error) {
      const failure = failureReason(error);
      if (this.#mode !== "auto" || this.#plan.kind !== "symmetric"
        || this.#retried || failure === undefined) {
        throw error;
      }
      this.#retried = true;
      await this.#model.dispose();
      const retryPlan = explicitRetryPlan(this.#description, this.#plan, failure);
      const built = await buildWorker(
        this.#description,
        retryPlan,
        this.#fieldWorkers,
        this.#fieldWorkerAssetBaseUrl,
      );
      this.#model = built.model;
      this.#plan = retryPlan;
      this.#application = built.application;
      await this.#model.prepare(options);
    }
  }

  async computeImpedanceMatrix(): Promise<ImpedanceResult> {
    const result = await this.#model.computeImpedanceMatrix();
    const scatter = this.#application.scatterCallerToNative;
    return {
      impedance: gatherComplexMatrix(result.impedance, scatter),
      admittance: gatherComplexMatrix(result.admittance, scatter),
      ...(result.conditionEstimate === undefined ? {} : { conditionEstimate: result.conditionEstimate }),
      frequencyMHz: result.frequencyMHz,
      factorizationGeneration: result.factorizationGeneration,
    };
  }

  async #solve(drive: "voltage" | "current", vector: ComplexVector): Promise<PortSolution> {
    const scatter = this.#application.scatterCallerToNative;
    const nativeVector = scatterComplexVector(vector, scatter);
    const result = drive === "voltage"
      ? await this.#model.solveVoltages(nativeVector)
      : await this.#model.solveCurrents(nativeVector);
    const powersW = new Float64Array(scatter.length);
    for (let caller = 0; caller < scatter.length; caller += 1) {
      powersW[caller] = result.powersW[scatter[caller]!]!;
    }
    return {
      drive: result.drive,
      frequencyMHz: result.frequencyMHz,
      ports: this.#application.callerPorts,
      requested: gatherComplexVector(result.requested, scatter),
      voltages: gatherComplexVector(result.voltages, scatter),
      currents: gatherComplexVector(result.currents, scatter),
      activeImpedances: gatherComplexVector(result.activeImpedances, scatter),
      powersW,
      powerBudget: result.powerBudget,
      factorizationGeneration: result.factorizationGeneration,
      solveGeneration: result.solveGeneration,
    };
  }

  solveVoltages(voltages: ComplexVector): Promise<PortSolution> {
    return this.#solve("voltage", voltages);
  }

  solveCurrents(currents: ComplexVector): Promise<PortSolution> {
    return this.#solve("current", currents);
  }

  async computeFarField(request: FarFieldRequest): Promise<FarFieldResult> {
    const result = await this.#model.computeFarField(request);
    if (result.fieldBackend !== undefined) {
      this.#fieldDiagnostics = result.fieldBackend;
    }
    const center = this.#plan.kind === "symmetric" ? this.#plan.centerM : [0, 0] as const;
    return rephaseFarField(result, center);
  }

  async computeEmbeddedFarFields(
    request: FarFieldRequest,
    normalization?: EmbeddedFieldNormalization,
  ): Promise<EmbeddedFarFieldResult> {
    const result = await this.#model.computeEmbeddedFarFields(request, normalization);
    const scatter = this.#application.scatterCallerToNative;
    const gathered: EmbeddedFarFieldResult = {
      ...result,
      ports: this.#application.callerPorts,
      eThetaReal: gatherEmbeddedBasis(result.eThetaReal, result.samplesPerPort, scatter),
      eThetaImag: gatherEmbeddedBasis(result.eThetaImag, result.samplesPerPort, scatter),
      ePhiReal: gatherEmbeddedBasis(result.ePhiReal, result.samplesPerPort, scatter),
      ePhiImag: gatherEmbeddedBasis(result.ePhiImag, result.samplesPerPort, scatter),
    };
    const center = this.#plan.kind === "symmetric" ? this.#plan.centerM : [0, 0] as const;
    return { ...gathered, ...rephaseArrays(gathered, center, scatter.length) };
  }

  cancelFarField(): void {
    this.#model.cancelFarField();
  }

  dispose(): Promise<void> {
    return this.#model.dispose();
  }

  getDiagnostics(): ArraySolverDiagnostics {
    return Object.freeze({
      representation: this.#plan.kind,
      planner: this.#plan.diagnostics,
      ...(this.#application.completion.symmetry === undefined
        ? {}
        : { symmetry: this.#application.completion.symmetry }),
      field: this.#fieldDiagnostics,
    });
  }
}

function pendingFieldDiagnostics(
  requestedWorkers: FieldWorkerSelection,
): FieldBackendDiagnostics {
  return Object.freeze({
    backend: "pending",
    requestedWorkers,
    activeWorkerCount: 0,
    tileSize: 512,
    totalTiles: 0,
    completedTiles: 0,
    cancelledTiles: 0,
    cancelledJobs: 0,
    restartedWorkers: 0,
    snapshotBytesPerWorker: 0,
    lastBroadcastBytesPerWorker: 0,
    resultBytes: 0,
    geometryReused: false,
    warmupMs: 0,
    snapshotCaptureMs: 0,
    snapshotBroadcastMs: 0,
    dispatchMs: 0,
    kernelMs: 0,
    mergeMs: 0,
    totalMs: 0,
  });
}

function resolveFieldAssetBase(value: string | URL | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!(typeof value === "string" || value instanceof URL)
      || (typeof value === "string" && value.trim().length === 0)) {
    throw new NecInputError("fieldWorkerAssetBaseUrl must be a nonempty string or URL");
  }
  try {
    const resolved = value instanceof URL
      ? new URL(value.href)
      : new URL(value, import.meta.url);
    if (!resolved.pathname.endsWith("/")) resolved.pathname += "/";
    return resolved.href;
  } catch (cause) {
    throw new NecInputError("fieldWorkerAssetBaseUrl is not a valid URL", { cause });
  }
}

/** Create one asynchronous solver facade for explicit and symmetric arrays. */
export async function createNecArraySolver(
  description: FullArrayDescription,
  options: CreateArraySolverOptions = {},
): Promise<NecArraySolver> {
  if (typeof options !== "object" || options === null) {
    throw new NecInputError("Array solver options must be an object");
  }
  const mode = options.symmetry ?? "auto";
  if (mode !== "auto" && mode !== "off" && mode !== "require") {
    throw new NecInputError("Unknown array symmetry mode", { details: { mode } });
  }
  if (mode !== "off" && options.symmetrizer === undefined) {
    throw new NecInputError(
      "Automatic array symmetry requires an explicit symmetrizer.positionEpsilonM",
    );
  }
  const fieldWorkers = options.fieldWorkers ?? "auto";
  if (fieldWorkers !== "auto"
      && (!Number.isInteger(fieldWorkers) || fieldWorkers < 1 || fieldWorkers > 8)) {
    throw new NecInputError("fieldWorkers must be \"auto\" or an integer from 1 through 8");
  }
  const fieldWorkerAssetBaseUrl = resolveFieldAssetBase(
    options.fieldWorkerAssetBaseUrl,
  );
  let plan = mode === "off"
    ? createExplicitArrayBuildPlan(description)
    : analyzeArraySymmetry(description, options.symmetrizer!);
  if (mode === "require" && plan.kind !== "symmetric") {
    throw new NecGeometryError("The array cannot be represented by supported symmetry", {
      details: { reasons: plan.reasons },
    });
  }
  try {
    const built = await buildWorker(
      description,
      plan,
      fieldWorkers,
      fieldWorkerAssetBaseUrl,
    );
    return new WorkerNecArraySolver(
      built.model,
      description,
      plan,
      built.application,
      mode,
      fieldWorkers,
      fieldWorkerAssetBaseUrl,
    );
  } catch (error) {
    const failure = failureReason(error);
    if (mode !== "auto" || plan.kind !== "symmetric" || failure === undefined) {
      throw error;
    }
    plan = explicitRetryPlan(description, plan, failure);
    const built = await buildWorker(
      description,
      plan,
      fieldWorkers,
      fieldWorkerAssetBaseUrl,
    );
    return new WorkerNecArraySolver(
      built.model,
      description,
      plan,
      built.application,
      mode,
      fieldWorkers,
      fieldWorkerAssetBaseUrl,
    );
  }
}
