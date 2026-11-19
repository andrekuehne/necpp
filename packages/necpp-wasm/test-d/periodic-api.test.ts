import {
  createNecPeriodicModel,
  type ComplexMatrix,
  type NecPeriodicModel,
  type PeriodicLattice,
  type ScanImpedanceResult,
  type ScanPhasesRad,
} from "../src/index.js";

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

  // A single cell of an infinite array has no far field of its own.
  // @ts-expect-error no far fields on the periodic model.
  void cell.computeFarField;
  // @ts-expect-error no embedded far fields on the periodic model.
  void cell.computeEmbeddedFarFields;
  // @ts-expect-error no isolated-element (ring-field) characterization on the periodic model.
  void cell.characterizeIsolatedElement;
  // @ts-expect-error no ground: the first periodic release is free space only.
  void cell.setGround;
  // @ts-expect-error unit cells take no symmetry options.
  cell.completeGeometry({ symmetry: { kind: "reflection", planes: ["x=0"], tagIncrement: 10 } });

  cell.dispose();
}
