export interface FieldEvaluatorWasmModule {
  HEAPF64: Float64Array;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  _necpp_field_evaluator_v1_version(): number;
  _necpp_field_evaluator_v1_evaluate(
    segmentCount: number, perfectGround: number,
    wavelengthM: number, radiusM: number,
    thetaStartDeg: number, thetaCount: number, thetaStepDeg: number,
    phiStartDeg: number, phiCount: number, phiStepDeg: number,
    sampleStart: number, sampleCount: number,
    x: number, y: number, z: number,
    cab: number, sab: number, salp: number, halfLengths: number,
    air: number, aii: number, bir: number, bii: number, cir: number, cii: number,
    eThetaReal: number, eThetaImag: number, ePhiReal: number, ePhiImag: number,
  ): number;
}

export interface FieldEvaluatorWasmOptions {
  readonly locateFile?: (path: string, prefix: string) => string;
  readonly wasmBinary?: Uint8Array;
}

export type FieldEvaluatorWasmFactory = (
  options?: FieldEvaluatorWasmOptions,
) => Promise<FieldEvaluatorWasmModule>;
