/** Three-dimensional Cartesian coordinate in metres. */
export type CartesianPointM = readonly [xM: number, yM: number, zM: number];

/** Public lifecycle state. */
export type NecModelState =
  | "empty"
  | "geometry-building"
  | "geometry-complete"
  | "prepared"
  | "solved"
  | "disposed";

/** A complex vector whose real and imaginary arrays have identical lengths. */
export interface ComplexVector {
  readonly real: Float64Array;
  readonly imag: Float64Array;
}

/** A dense complex matrix in row-major order. */
export interface ComplexMatrix extends ComplexVector {
  readonly rows: number;
  readonly columns: number;
  readonly order: "row-major";
}

/** A straight, round wire. Segment positions are uniformly spaced. */
export interface WireDefinition {
  /** Positive integer used to address the wire and its segments. */
  readonly tag: number;
  /** Positive integer segment count. Odd counts are recommended at feeds. */
  readonly segments: number;
  readonly start: CartesianPointM;
  readonly end: CartesianPointM;
  readonly radiusM: number;
}

/** How wire ends on z=0 are treated when geometry is completed. */
export type GroundConnection = "none" | "interpolate" | "zero-current";

/** A coordinate plane through the global NEC model origin. */
export type ReflectionPlane = "x=0" | "y=0" | "z=0";

declare const rotationalOrderBrand: unique symbol;

/**
 * An integer rotational section count greater than or equal to two.
 * Construct values with {@link rotationalOrder} so the range check is explicit.
 */
export type RotationalOrder = number & {
  readonly [rotationalOrderBrand]: "RotationalOrder";
};

export interface ReflectionSymmetry {
  readonly kind: "reflection";
  /** Nonempty set of generating planes. Order does not affect copy order. */
  readonly planes: readonly [ReflectionPlane, ...ReflectionPlane[]];
  /** Positive integer offset applied once per generated copy block. */
  readonly tagIncrement: number;
}

export interface RotationalSymmetry {
  readonly kind: "rotational";
  /** The first public contract supports only the global Z axis. */
  readonly axis: "z";
  /** Total number of sections, including the fundamental section. */
  readonly order: RotationalOrder;
  /** Positive integer offset applied once per generated copy block. */
  readonly tagIncrement: number;
}

export type GeometrySymmetry = ReflectionSymmetry | RotationalSymmetry;

export interface CartesianSignsTransform {
  readonly kind: "cartesian-signs";
  readonly signs: readonly [x: 1 | -1, y: 1 | -1, z: 1 | -1];
}

export interface RotateZTransform {
  readonly kind: "rotate-z";
  readonly angleDeg: number;
}

export type SymmetryCopyTransform = CartesianSignsTransform | RotateZTransform;

export interface SymmetryCopy {
  /** Zero-based native copy-block index; zero is the fundamental section. */
  readonly index: number;
  readonly tagOffset: number;
  readonly transform: SymmetryCopyTransform;
}

export interface SymmetryExpansion {
  readonly kind: GeometrySymmetry["kind"];
  readonly sectionCount: number;
  readonly fundamentalSegmentCount: number;
  readonly fullSegmentCount: number;
  /** Native copy-major order. This is not caller spatial order. */
  readonly copies: readonly SymmetryCopy[];
}

/** Stable machine-readable classifications attached to symmetry failures. */
export type SymmetryFailureReason =
  | "INVALID_SYMMETRY"
  | "INCOMPATIBLE_GROUND"
  | "INCOMPLETE_LOAD_ORBIT"
  | "UNSUPPORTED_ELEMENT_PATTERN_TRANSFORM";

export type SymmetryFailureClassification =
  | {
      readonly reason: "INVALID_SYMMETRY";
      readonly errorCode: "NEC_INPUT";
      readonly representationEligibilityFailure: false;
    }
  | {
      readonly reason:
        | "INCOMPATIBLE_GROUND"
        | "INCOMPLETE_LOAD_ORBIT"
        | "UNSUPPORTED_ELEMENT_PATTERN_TRANSFORM";
      readonly errorCode: "NEC_GEOMETRY";
      /** Automatic builders still verify that the unchanged full model is valid. */
      readonly representationEligibilityFailure: true;
    };

export interface CompleteGeometryOptions {
  /** Defaults to `"none"`. A non-none value declares a ground plane at z=0. */
  readonly groundConnection?: GroundConnection;
  /** Final geometry-generation operation before connection/completion. */
  readonly symmetry?: GeometrySymmetry;
}

export interface GeometryCompletionResult {
  /** Absent for ordinary, non-symmetric geometry completion. */
  readonly symmetry?: SymmetryExpansion;
}

/** One-based segment position among all segments carrying `tag`. */
export interface PortDefinition {
  readonly tag: number;
  readonly segment: number;
  /** Optional stable consumer label; it does not affect the numerical model. */
  readonly name?: string;
}

/** Selects one or more segments for a load. Segment positions are one-based. */
export interface SegmentSelection {
  /** Zero selects absolute segment numbers; a positive value selects a wire tag. */
  readonly tag: number;
  /** Omit both bounds to select every segment carrying a nonzero `tag`. */
  readonly firstSegment?: number;
  /** Defaults to `firstSegment` when the first bound is present. */
  readonly lastSegment?: number;
}

export interface SeriesRlcLoad {
  readonly kind: "series-rlc";
  readonly target: SegmentSelection;
  readonly resistanceOhm: number;
  readonly inductanceH: number;
  readonly capacitanceF: number;
  readonly perMeter?: false;
}

export interface ParallelRlcLoad {
  readonly kind: "parallel-rlc";
  readonly target: SegmentSelection;
  readonly resistanceOhm: number;
  readonly inductanceH: number;
  readonly capacitanceF: number;
  readonly perMeter?: false;
}

export interface DistributedSeriesRlcLoad {
  readonly kind: "series-rlc";
  readonly target: SegmentSelection;
  readonly resistanceOhm: number;
  readonly inductanceH: number;
  readonly capacitanceF: number;
  readonly perMeter: true;
}

export interface DistributedParallelRlcLoad {
  readonly kind: "parallel-rlc";
  readonly target: SegmentSelection;
  readonly resistanceOhm: number;
  readonly inductanceH: number;
  readonly capacitanceF: number;
  readonly perMeter: true;
}

export interface ImpedanceLoad {
  readonly kind: "impedance";
  readonly target: SegmentSelection;
  readonly resistanceOhm: number;
  readonly reactanceOhm: number;
}

export interface ConductivityLoad {
  readonly kind: "conductivity";
  readonly target: SegmentSelection;
  readonly conductivitySPerM: number;
}

export type LoadDefinition =
  | SeriesRlcLoad
  | ParallelRlcLoad
  | DistributedSeriesRlcLoad
  | DistributedParallelRlcLoad
  | ImpedanceLoad
  | ConductivityLoad;

export interface FreeSpaceGround {
  readonly kind: "free-space";
}

export interface PerfectGround {
  readonly kind: "perfect";
}

export interface FiniteGround {
  readonly kind: "finite";
  readonly method: "reflection-coefficient" | "sommerfeld-norton";
  readonly relativePermittivity: number;
  readonly conductivitySPerM: number;
}

export type GroundModel = FreeSpaceGround | PerfectGround | FiniteGround;

export interface PrepareOptions {
  /** Frequency in megahertz; must be finite and greater than zero. */
  readonly frequencyMHz: number;
}

export interface ImpedanceResult {
  readonly impedance: ComplexMatrix;
  readonly admittance: ComplexMatrix;
  readonly conditionEstimate?: number;
  readonly frequencyMHz: number;
  /** Native cache generation used for deterministic cache tests and diagnostics. */
  readonly factorizationGeneration: number;
}

export interface PortSolution {
  readonly drive: "voltage" | "current";
  readonly frequencyMHz: number;
  readonly ports: readonly PortDefinition[];
  /** Requested drive values, in volts or amperes according to `drive`. */
  readonly requested: ComplexVector;
  /** Achieved complex port voltages in volts. */
  readonly voltages: ComplexVector;
  /** Achieved complex port currents in amperes, positive into the antenna. */
  readonly currents: ComplexVector;
  /** Element-wise V/I in ohms; NaN + jNaN where current is exactly zero. */
  readonly activeImpedances: ComplexVector;
  /** Time-average input power: 0.5 * Re(V * conjugate(I)), in watts. */
  readonly powersW: Float64Array;
  readonly factorizationGeneration: number;
  readonly solveGeneration: number;
}

export interface AngleSweep {
  readonly startDeg: number;
  readonly count: number;
  readonly stepDeg: number;
}

export interface FarFieldRequest {
  /** Defaults to 1 metre and must be finite and greater than zero. */
  readonly radiusM?: number;
  readonly theta: AngleSweep;
  readonly phi: AngleSweep;
}

export interface FarFieldResult {
  readonly radiusM: number;
  readonly frequencyMHz: number;
  readonly thetaDeg: Float64Array;
  readonly phiDeg: Float64Array;
  /** Sample index is `phiIndex * thetaDeg.length + thetaIndex`. */
  readonly eThetaReal: Float64Array;
  readonly eThetaImag: Float64Array;
  readonly ePhiReal: Float64Array;
  readonly ePhiImag: Float64Array;
}

export type EmbeddedFieldNormalization =
  | { readonly kind: "unit-voltage"; readonly valueV: 1 }
  | { readonly kind: "unit-current"; readonly valueA: 1 };

export interface EmbeddedFarFieldResult extends FarFieldResult {
  readonly ports: readonly PortDefinition[];
  readonly normalization: EmbeddedFieldNormalization;
  /** Number of angular samples for one port. */
  readonly samplesPerPort: number;
  /**
   * Field arrays are basis-major: `portIndex * samplesPerPort + sampleIndex`.
   * They therefore contain `ports.length * samplesPerPort` entries.
   */
  readonly eThetaReal: Float64Array;
  readonly eThetaImag: Float64Array;
  readonly ePhiReal: Float64Array;
  readonly ePhiImag: Float64Array;
}

export interface CreateNecModelOptions {
  /** Override the package-relative URL used to load `nec2pp.wasm`. */
  readonly wasmUrl?: string | URL;
  /** Caller-owned WASM bytes. The factory does not retain or mutate this buffer. */
  readonly wasmBinary?: ArrayBuffer | Uint8Array;
}

export interface RunDeckOptions extends CreateNecModelOptions {
  /** Abort before starting; an in-progress synchronous native solve is not interruptible. */
  readonly signal?: AbortSignal;
}

export interface DeckResult {
  readonly report: string;
  readonly engineVersion: string;
}

/** Stateful high-level model. All returned arrays are caller-owned copies. */
export interface NecModel {
  readonly state: NecModelState;

  addWire(wire: WireDefinition): void;
  completeGeometry(options?: CompleteGeometryOptions): GeometryCompletionResult;
  definePorts(ports: readonly PortDefinition[]): void;
  addLoad(load: LoadDefinition): void;
  clearLoads(): void;
  setGround(ground: GroundModel): void;
  prepare(options: PrepareOptions): void;
  computeImpedanceMatrix(): ImpedanceResult;
  solveVoltages(voltages: ComplexVector): PortSolution;
  solveCurrents(currents: ComplexVector): PortSolution;
  computeFarField(request: FarFieldRequest): FarFieldResult;
  computeEmbeddedFarFields(
    request: FarFieldRequest,
    normalization?: EmbeddedFieldNormalization,
  ): EmbeddedFarFieldResult;
  /** Idempotent. After disposal, every operation except `state` and `dispose` fails. */
  dispose(): void;
}

/** Coarse worker-boundary operation names, including worker-only `create`. */
export type NecWorkerOperation =
  | "create"
  | "addWire"
  | "completeGeometry"
  | "definePorts"
  | "addLoad"
  | "clearLoads"
  | "setGround"
  | "prepare"
  | "computeImpedanceMatrix"
  | "solveVoltages"
  | "solveCurrents"
  | "computeFarField"
  | "computeEmbeddedFarFields"
  | "dispose";

export interface NecWorkerProgressEvent {
  readonly operation: NecWorkerOperation;
  readonly phase: "start" | "complete";
}

export type NecWorkerProgressListener = (event: NecWorkerProgressEvent) => void;

export interface CreateNecWorkerModelOptions extends CreateNecModelOptions {
  /** Invoked on the client thread at worker operation start and completion. */
  readonly onProgress?: NecWorkerProgressListener;
}

/**
 * Worker-backed model. Methods are asynchronous, serialized per instance, and
 * otherwise match `NecModel`. `terminate()` is the cancellation mechanism.
 */
export interface NecWorkerModel {
  readonly state: NecModelState;

  addWire(wire: WireDefinition): Promise<void>;
  completeGeometry(
    options?: CompleteGeometryOptions,
  ): Promise<GeometryCompletionResult>;
  definePorts(ports: readonly PortDefinition[]): Promise<void>;
  addLoad(load: LoadDefinition): Promise<void>;
  clearLoads(): Promise<void>;
  setGround(ground: GroundModel): Promise<void>;
  prepare(options: PrepareOptions): Promise<void>;
  computeImpedanceMatrix(): Promise<ImpedanceResult>;
  solveVoltages(voltages: ComplexVector): Promise<PortSolution>;
  solveCurrents(currents: ComplexVector): Promise<PortSolution>;
  computeFarField(request: FarFieldRequest): Promise<FarFieldResult>;
  computeEmbeddedFarFields(
    request: FarFieldRequest,
    normalization?: EmbeddedFieldNormalization,
  ): Promise<EmbeddedFarFieldResult>;
  /** Idempotent. Disposes the native model, then releases the worker thread. */
  dispose(): Promise<void>;
  /**
   * Immediately kills the worker and rejects outstanding operations.
   * Idempotent. The `state` getter afterwards is `"disposed"`.
   */
  terminate(): void;
  /** Register a progress listener. Returns an unsubscribe function. */
  subscribeProgress(listener: NecWorkerProgressListener): () => void;
}
