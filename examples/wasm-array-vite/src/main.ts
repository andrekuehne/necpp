import {
  NecError,
  createNecArraySolver,
  packageVersion,
  type ComplexMatrix,
  type FarFieldResult,
  type FullArrayDescription,
  type PortSolution,
} from "@necpp-engine/wasm";

import "./style.css";

interface ExampleResult {
  readonly ready: true;
  readonly packageVersion: string;
  readonly portCount: number;
  readonly fieldSamples: number;
  readonly finite: boolean;
  readonly representation: "explicit" | "symmetric";
  readonly maxPositionAdjustmentM: number;
  readonly reasonCodes: readonly string[];
  readonly wasmResponsesExpected: true;
}

declare global {
  interface Window {
    __NECPP_EXAMPLE_RESULT__?: ExampleResult | { readonly error: string };
  }
}

const elementPositionsM = [-0.45, -0.15, 0.15, 0.45] as const;
const phaseStepRad = -Math.PI / 3;
const status = requiredElement<HTMLParagraphElement>("status");

function requiredElement<T extends Element>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Missing #${id}`);
  }
  return element as T;
}

function formatComplex(real: number, imag: number, digits = 3): string {
  const sign = imag < 0 ? "−" : "+";
  return `${real.toFixed(digits)} ${sign} j${Math.abs(imag).toFixed(digits)}`;
}

function matrixEntry(matrix: ComplexMatrix, row: number, column: number) {
  const index = row * matrix.columns + column;
  return {
    real: matrix.real[index]!,
    imag: matrix.imag[index]!,
  };
}

function renderMatrix(matrix: ComplexMatrix, conditionEstimate?: number): void {
  const body = requiredElement<HTMLTableElement>("matrix").tBodies[0]!;
  const header = document.createElement("tr");
  header.append(document.createElement("th"));
  for (let column = 0; column < matrix.columns; column += 1) {
    const cell = document.createElement("th");
    cell.textContent = `Port ${column + 1}`;
    header.append(cell);
  }
  body.append(header);

  for (let row = 0; row < matrix.rows; row += 1) {
    const tableRow = document.createElement("tr");
    const heading = document.createElement("th");
    heading.textContent = `Port ${row + 1}`;
    tableRow.append(heading);
    for (let column = 0; column < matrix.columns; column += 1) {
      const value = matrixEntry(matrix, row, column);
      const cell = document.createElement("td");
      cell.textContent = formatComplex(value.real, value.imag, 2);
      tableRow.append(cell);
    }
    body.append(tableRow);
  }

  requiredElement("condition").textContent = conditionEstimate === undefined
    ? "Condition estimate unavailable"
    : `2-norm condition estimate: ${conditionEstimate.toExponential(3)}`;
}

function renderPorts(solution: PortSolution): void {
  const body = requiredElement<HTMLTableElement>("ports").tBodies[0]!;
  for (let port = 0; port < solution.ports.length; port += 1) {
    const row = document.createElement("tr");
    const values = [
      solution.ports[port]!.name ?? String(port + 1),
      formatComplex(solution.requested.real[port]!, solution.requested.imag[port]!),
      formatComplex(solution.currents.real[port]!, solution.currents.imag[port]!),
      formatComplex(solution.voltages.real[port]!, solution.voltages.imag[port]!),
      formatComplex(
        solution.activeImpedances.real[port]!,
        solution.activeImpedances.imag[port]!,
        2,
      ),
      solution.powersW[port]!.toFixed(3),
    ];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    body.append(row);
  }
}

function renderPlot(field: FarFieldResult): void {
  const svg = requiredElement<SVGSVGElement>("plot");
  const width = 960;
  const height = 360;
  const margin = { top: 24, right: 24, bottom: 44, left: 58 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  if (field.eThetaReal.length < 2) {
    throw new Error(`Expected at least two field samples, received ${field.eThetaReal.length}`);
  }
  const magnitudes = field.eThetaReal.map((thetaReal, index) => Math.hypot(
    thetaReal,
    field.eThetaImag[index]!,
    field.ePhiReal[index]!,
    field.ePhiImag[index]!,
  ));
  const peak = Math.max(...magnitudes);
  if (!Number.isFinite(peak) || peak <= 0) {
    throw new Error(`Expected a positive finite field peak, received ${peak}`);
  }
  const decibels = magnitudes.map((value) => Math.max(
    -40,
    20 * Math.log10(Math.max(value / peak, Number.EPSILON)),
  ));
  const pointList = Array.from(decibels, (db, index) => {
    const x = margin.left + (index / (decibels.length - 1)) * innerWidth;
    const y = margin.top + (-db / 40) * innerHeight;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  if (pointList.includes("NaN")) {
    throw new Error(
      `Invalid plot coordinates: samples=${decibels.length}, peak=${peak}, firstDb=${decibels[0]}`,
    );
  }

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = `
    <title id="plot-title">Normalized azimuth far-field cut</title>
    <desc id="plot-description">Field magnitude from 0 to 360 degrees, clipped at minus 40 decibels.</desc>
    <g class="grid">
      <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" />
      <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" />
      ${[0, -10, -20, -30, -40].map((db) => {
        const y = margin.top + (-db / 40) * innerHeight;
        return `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" />
          <text x="${margin.left - 10}" y="${y + 4}" text-anchor="end">${db} dB</text>`;
      }).join("")}
      ${[0, 90, 180, 270, 360].map((phi) => {
        const x = margin.left + (phi / 360) * innerWidth;
        return `<text x="${x}" y="${height - 15}" text-anchor="middle">${phi}°</text>`;
      }).join("")}
    </g>
    <polyline class="pattern" points="${pointList}" />
  `;
}

async function run(): Promise<ExampleResult> {
  // This is always the caller's complete array. The solver decides whether to
  // construct it explicitly or reduce it internally, without changing the
  // prepare/matrix/solve/field calls below.
  const description = {
    elements: elementPositionsM.map((xM, index) => ({
      id: `element-${index + 1}`,
      positionM: [xM, 0] as const,
      patternId: "dipole",
    })),
    patterns: [{
      id: "dipole",
      kind: "straight-wire-pattern",
      wires: [{
        id: "radiator",
        segments: 11,
        startM: [0, 0, -0.25],
        endM: [0, 0, 0.25],
        radiusM: 0.001,
      }],
      ports: [{ wireId: "radiator", segment: 6 }],
    }],
    ground: { kind: "free-space" },
  } satisfies FullArrayDescription;
  const model = await createNecArraySolver(description, {
    symmetry: "auto",
    symmetrizer: {
      positionEpsilonM: 0,
      allowRotation: false,
    },
  });

  try {
    const initialDiagnostics = model.getDiagnostics();
    status.textContent = initialDiagnostics.representation === "symmetric"
      ? `Accepted ${initialDiagnostics.symmetry?.sectionCount}-section symmetry; preparing…`
      : `Using explicit geometry: ${initialDiagnostics.planner.reasons
        .map(({ code }) => code).join(", ")}; preparing…`;
    await model.prepare({ frequencyMHz: 300 });

    const matrices = await model.computeImpedanceMatrix();
    const currents = {
      real: Float64Array.from(elementPositionsM, (_, index) => Math.cos(index * phaseStepRad)),
      imag: Float64Array.from(elementPositionsM, (_, index) => Math.sin(index * phaseStepRad)),
    };
    const solution = await model.solveCurrents(currents);
    const field = await model.computeFarField({
      radiusM: 1,
      theta: { startDeg: 90, count: 1, stepDeg: 0 },
      phi: { startDeg: 0, count: 361, stepDeg: 1 },
    });

    renderMatrix(matrices.impedance, matrices.conditionEstimate);
    renderPorts(solution);
    renderPlot(field);

    const finite = [
      ...matrices.impedance.real,
      ...matrices.impedance.imag,
      ...solution.voltages.real,
      ...solution.voltages.imag,
      ...field.eThetaReal,
      ...field.eThetaImag,
      ...field.ePhiReal,
      ...field.ePhiImag,
    ].every(Number.isFinite);
    const diagnostics = model.getDiagnostics();
    return {
      ready: true,
      packageVersion,
      portCount: solution.ports.length,
      fieldSamples: field.eThetaReal.length,
      finite,
      representation: diagnostics.representation,
      maxPositionAdjustmentM: diagnostics.planner.maxPositionAdjustmentM,
      reasonCodes: diagnostics.planner.reasons.map(({ code }) => code),
      wasmResponsesExpected: true,
    };
  } finally {
    await model.dispose();
  }
}

try {
  const result = await run();
  window.__NECPP_EXAMPLE_RESULT__ = result;
  const decision = result.representation === "symmetric"
    ? "symmetry accepted"
    : `explicit fallback (${result.reasonCodes.join(", ")})`;
  status.textContent = `Ready · ${decision} · max adjustment ${result.maxPositionAdjustmentM} m · @necpp-engine/wasm ${packageVersion}`;
  status.classList.add("ready");
} catch (error: unknown) {
  const message = error instanceof NecError
    ? `${error.code}: ${error.message}`
    : error instanceof Error ? error.stack ?? error.message : String(error);
  status.textContent = message;
  status.classList.add("error");
  window.__NECPP_EXAMPLE_RESULT__ = { error: message };
}
