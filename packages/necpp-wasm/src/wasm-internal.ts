/** Handwritten private view of the stable v1 ABI. Never exported publicly. */
export interface NecWasmModule {
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  HEAPF64: Float64Array;

  _malloc(bytes: number): number;
  _free(pointer: number): void;

  _necpp_wasm_v1_abi_version(): number;
  _necpp_wasm_v1_engine_version(): number;

  _necpp_wasm_v1_model_create(): number;
  _necpp_wasm_v1_model_delete(model: number): void;
  _necpp_wasm_v1_model_state(model: number): number;
  _necpp_wasm_v1_last_status(model: number): number;
  _necpp_wasm_v1_last_error(model: number): number;

  _necpp_wasm_v1_add_wire(
    model: number,
    tag: number,
    segments: number,
    x1: number,
    y1: number,
    z1: number,
    x2: number,
    y2: number,
    z2: number,
    radiusM: number,
  ): number;
  _necpp_wasm_v1_complete_geometry(model: number, connection: number): number;
  _necpp_wasm_v1_complete_geometry_symmetric(
    model: number,
    connection: number,
    symmetryKind: number,
    parameter: number,
    tagIncrement: number,
  ): number;
  _necpp_wasm_v1_define_ports(
    model: number,
    tags: number,
    segments: number,
    count: number,
  ): number;
  _necpp_wasm_v1_add_load(
    model: number,
    kind: number,
    tag: number,
    firstSegment: number,
    lastSegment: number,
    value1: number,
    value2: number,
    value3: number,
  ): number;
  _necpp_wasm_v1_clear_loads(model: number): number;
  _necpp_wasm_v1_set_ground(
    model: number,
    kind: number,
    relativePermittivity: number,
    conductivitySPerM: number,
  ): number;
  _necpp_wasm_v1_prepare(model: number, frequencyMHz: number): number;
  _necpp_wasm_v1_compute_impedance(model: number): number;
  _necpp_wasm_v1_solve_voltages(
    model: number,
    real: number,
    imag: number,
    count: number,
  ): number;
  _necpp_wasm_v1_solve_currents(
    model: number,
    real: number,
    imag: number,
    count: number,
  ): number;
  _necpp_wasm_v1_compute_far_field(
    model: number,
    radiusM: number,
    thetaStartDeg: number,
    thetaCount: number,
    thetaStepDeg: number,
    phiStartDeg: number,
    phiCount: number,
    phiStepDeg: number,
  ): number;
  _necpp_wasm_v1_compute_embedded_far_fields(
    model: number,
    radiusM: number,
    thetaStartDeg: number,
    thetaCount: number,
    thetaStepDeg: number,
    phiStartDeg: number,
    phiCount: number,
    phiStepDeg: number,
    normalization: number,
  ): number;

  _necpp_wasm_v1_impedance_order(model: number): number;
  _necpp_wasm_v1_impedance_frequency_mhz(model: number): number;
  _necpp_wasm_v1_impedance_condition_estimate(model: number): number;
  _necpp_wasm_v1_impedance_factorization_generation(model: number): number;

  _necpp_wasm_v1_solution_count(model: number): number;
  _necpp_wasm_v1_solution_drive(model: number): number;
  _necpp_wasm_v1_solution_frequency_mhz(model: number): number;
  _necpp_wasm_v1_solution_factorization_generation(model: number): number;
  _necpp_wasm_v1_solution_generation(model: number): number;

  _necpp_wasm_v1_far_field_radius_m(model: number): number;
  _necpp_wasm_v1_far_field_frequency_mhz(model: number): number;
  _necpp_wasm_v1_far_field_theta_count(model: number): number;
  _necpp_wasm_v1_far_field_phi_count(model: number): number;

  _necpp_wasm_v1_embedded_radius_m(model: number): number;
  _necpp_wasm_v1_embedded_frequency_mhz(model: number): number;
  _necpp_wasm_v1_embedded_theta_count(model: number): number;
  _necpp_wasm_v1_embedded_phi_count(model: number): number;
  _necpp_wasm_v1_embedded_port_count(model: number): number;
  _necpp_wasm_v1_embedded_samples_per_port(model: number): number;
  _necpp_wasm_v1_embedded_normalization(model: number): number;

  _necpp_wasm_v1_geometry_symmetry_kind(model: number): number;
  _necpp_wasm_v1_geometry_section_count(model: number): number;
  _necpp_wasm_v1_geometry_fundamental_segment_count(model: number): bigint;
  _necpp_wasm_v1_geometry_full_segment_count(model: number): bigint;

  _necpp_wasm_v1_result_buffer(model: number, kind: number): number;
  _necpp_wasm_v1_result_buffer_length(model: number, kind: number): number;

  _necpp_wasm_v1_deck_create(): number;
  _necpp_wasm_v1_deck_delete(deck: number): void;
  _necpp_wasm_v1_deck_process(
    deck: number,
    utf8: number,
    length: number,
  ): number;
  _necpp_wasm_v1_deck_last_status(deck: number): number;
  _necpp_wasm_v1_deck_last_error(deck: number): number;
  _necpp_wasm_v1_deck_output(deck: number): number;
  _necpp_wasm_v1_deck_output_length(deck: number): number;
}

export interface EmscriptenModuleOptions {
  readonly locateFile?: (path: string, prefix: string) => string;
  readonly wasmBinary?: Uint8Array;
}

export type NecWasmModuleFactory = (
  options?: EmscriptenModuleOptions,
) => Promise<NecWasmModule>;
