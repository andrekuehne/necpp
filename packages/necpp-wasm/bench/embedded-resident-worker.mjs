import { parentPort } from "node:worker_threads";

let basis;

function validateVector(value, length) {
  if (!(value?.real instanceof Float64Array)
      || !(value?.imag instanceof Float64Array)
      || value.real.length !== length || value.imag.length !== length) {
    throw new TypeError(`Expected ${length} complex weights`);
  }
}

function combine(weights) {
  if (basis === undefined) throw new Error("Embedded basis is not initialized");
  validateVector(weights, basis.portCount);
  const eThetaReal = new Float64Array(basis.samplesPerPort);
  const eThetaImag = new Float64Array(basis.samplesPerPort);
  const ePhiReal = new Float64Array(basis.samplesPerPort);
  const ePhiImag = new Float64Array(basis.samplesPerPort);
  for (let port = 0; port < basis.portCount; port += 1) {
    const weightReal = weights.real[port];
    const weightImag = weights.imag[port];
    const offset = port * basis.samplesPerPort;
    for (let sample = 0; sample < basis.samplesPerPort; sample += 1) {
      const source = offset + sample;
      const thetaReal = basis.eThetaReal[source];
      const thetaImag = basis.eThetaImag[source];
      const phiReal = basis.ePhiReal[source];
      const phiImag = basis.ePhiImag[source];
      eThetaReal[sample] += thetaReal * weightReal - thetaImag * weightImag;
      eThetaImag[sample] += thetaReal * weightImag + thetaImag * weightReal;
      ePhiReal[sample] += phiReal * weightReal - phiImag * weightImag;
      ePhiImag[sample] += phiReal * weightImag + phiImag * weightReal;
    }
  }
  return { eThetaReal, eThetaImag, ePhiReal, ePhiImag };
}

parentPort.on("message", (message) => {
  try {
    if (message.kind === "initialize") {
      const candidate = message.basis;
      const total = candidate.portCount * candidate.samplesPerPort;
      for (const name of ["eThetaReal", "eThetaImag", "ePhiReal", "ePhiImag"]) {
        if (!(candidate[name] instanceof Float64Array)
            || candidate[name].length !== total) {
          throw new TypeError("Embedded basis has invalid component arrays");
        }
      }
      basis = candidate;
      parentPort.postMessage({ id: message.id, kind: "initialized" });
      return;
    }
    if (message.kind === "combine") {
      const started = performance.now();
      const field = combine(message.weights);
      const computeMs = performance.now() - started;
      const transfer = Object.values(field).map((value) => value.buffer);
      parentPort.postMessage({ id: message.id, kind: "field", field, computeMs }, transfer);
      return;
    }
    if (message.kind === "release") {
      basis = undefined;
      parentPort.postMessage({ id: message.id, kind: "released" });
      return;
    }
    throw new Error("Unknown resident embedded-field request");
  } catch (error) {
    parentPort.postMessage({
      id: message?.id ?? -1,
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
