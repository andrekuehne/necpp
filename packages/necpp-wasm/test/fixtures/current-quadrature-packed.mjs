const NECQ_HEADER_BYTES = 64;
const NECF_HEADER_BYTES = 64;
const NECQ_SCHEMA_VERSION = 1;
const NECF_SCHEMA_VERSION = 1;
const NECQ_FLAG_IMAGES = 1;
const NECQ_FLAG_WEIGHTS = 2;

export function packedMagic(buffer) {
  const bytes = new Uint8Array(buffer, 0, 4);
  return String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
}

export function identityBytes(nSegments) {
  return 12 * nSegments;
}

export function identityPadBytes(nSegments) {
  const unpadded = NECQ_HEADER_BYTES + identityBytes(nSegments);
  return (8 - (unpadded % 8)) % 8;
}

export function necqPackedBytes(nModes, nSegments, nNodes, nImagePlanes) {
  const geometry = nSegments * nNodes * nImagePlanes;
  return NECQ_HEADER_BYTES
    + identityBytes(nSegments)
    + identityPadBytes(nSegments)
    + 9 * geometry * 8
    + 2 * nModes * geometry * 8;
}

export function necfPackedBytes(nPorts, nTheta, nPhi) {
  const samplesPerPort = nTheta * nPhi;
  return NECF_HEADER_BYTES
    + (nTheta + nPhi + 4 * nPorts * samplesPerPort) * 8;
}

function requireMagic(buffer, expected) {
  const magic = packedMagic(buffer);
  if (magic !== expected) {
    throw new Error(`expected ${expected} magic, received ${magic}`);
  }
}

function f64Plane(view, byteOffset, count) {
  return new Float64Array(view.buffer, view.byteOffset + byteOffset, count);
}

function i32Plane(view, byteOffset, count) {
  return new Int32Array(view.buffer, view.byteOffset + byteOffset, count);
}

export function viewPreparedQuadrature(buffer) {
  requireMagic(buffer, "NECQ");
  const header = new DataView(buffer);
  const schemaVersion = header.getUint32(4, true);
  if (schemaVersion !== NECQ_SCHEMA_VERSION) {
    throw new Error(`unsupported NECQ schema ${schemaVersion}`);
  }
  const flags = header.getUint32(8, true);
  const nSegments = header.getUint32(12, true);
  const nNodes = header.getUint32(16, true);
  const nModes = header.getUint32(20, true);
  const nImagePlanes = header.getUint32(24, true);
  const expected = necqPackedBytes(nModes, nSegments, nNodes, nImagePlanes);
  if (buffer.byteLength !== expected) {
    throw new Error(`NECQ size ${buffer.byteLength} != ${expected}`);
  }
  const geometryCount = nSegments * nNodes * nImagePlanes;
  const currentCount = nModes * geometryCount;
  const identityLen = identityBytes(nSegments);
  const pad = identityPadBytes(nSegments);
  const bytes = new Uint8Array(buffer);
  const identityOffset = NECQ_HEADER_BYTES;
  const geometryOffset = identityOffset + identityLen + pad;
  let offset = geometryOffset;
  const x = f64Plane(bytes, offset, geometryCount);
  offset += geometryCount * 8;
  const y = f64Plane(bytes, offset, geometryCount);
  offset += geometryCount * 8;
  const z = f64Plane(bytes, offset, geometryCount);
  offset += geometryCount * 8;
  const tx = f64Plane(bytes, offset, geometryCount);
  offset += geometryCount * 8;
  const ty = f64Plane(bytes, offset, geometryCount);
  offset += geometryCount * 8;
  const tz = f64Plane(bytes, offset, geometryCount);
  offset += geometryCount * 8;
  const radiusM = f64Plane(bytes, offset, geometryCount);
  offset += geometryCount * 8;
  const lengthM = f64Plane(bytes, offset, geometryCount);
  offset += geometryCount * 8;
  const dsWeight = f64Plane(bytes, offset, geometryCount);
  offset += geometryCount * 8;
  const iReal = f64Plane(bytes, offset, currentCount);
  offset += currentCount * 8;
  const iImag = f64Plane(bytes, offset, currentCount);
  return {
    schemaVersion,
    flags,
    nSegments,
    nNodes,
    nModes,
    nImagePlanes,
    frequencyMHz: header.getFloat64(32, true),
    wavelengthM: header.getFloat64(40, true),
    modelGeneration: header.getBigUint64(48, true),
    solutionGeneration: header.getBigUint64(56, true),
    hasImages: (flags & NECQ_FLAG_IMAGES) !== 0,
    hasWeights: (flags & NECQ_FLAG_WEIGHTS) !== 0,
    tag: i32Plane(bytes, identityOffset, nSegments),
    segment: i32Plane(bytes, identityOffset + nSegments * 4, nSegments),
    nativeIndex: i32Plane(bytes, identityOffset + nSegments * 8, nSegments),
    x,
    y,
    z,
    tx,
    ty,
    tz,
    radiusM,
    lengthM,
    dsWeight,
    iReal,
    iImag,
    geometryCount,
    currentCount,
    geometryIndex(plane, segmentIndex, node) {
      return (plane * nSegments + segmentIndex) * nNodes + node;
    },
    currentIndex(mode, plane, segmentIndex, node) {
      return ((mode * nImagePlanes + plane) * nSegments + segmentIndex) * nNodes
        + node;
    },
  };
}

export function viewEmbeddedField(buffer) {
  requireMagic(buffer, "NECF");
  const header = new DataView(buffer);
  const schemaVersion = header.getUint32(4, true);
  if (schemaVersion !== NECF_SCHEMA_VERSION) {
    throw new Error(`unsupported NECF schema ${schemaVersion}`);
  }
  const nPorts = header.getUint32(8, true);
  const nTheta = header.getUint32(12, true);
  const nPhi = header.getUint32(16, true);
  const samplesPerPort = header.getUint32(20, true);
  if (samplesPerPort !== nTheta * nPhi) {
    throw new Error("NECF samplesPerPort does not match nTheta * nPhi");
  }
  const expected = necfPackedBytes(nPorts, nTheta, nPhi);
  if (buffer.byteLength !== expected) {
    throw new Error(`NECF size ${buffer.byteLength} != ${expected}`);
  }
  const fieldLen = nPorts * samplesPerPort;
  const bytes = new Uint8Array(buffer);
  let offset = NECF_HEADER_BYTES;
  const thetaDeg = f64Plane(bytes, offset, nTheta);
  offset += nTheta * 8;
  const phiDeg = f64Plane(bytes, offset, nPhi);
  offset += nPhi * 8;
  const eThetaReal = f64Plane(bytes, offset, fieldLen);
  offset += fieldLen * 8;
  const eThetaImag = f64Plane(bytes, offset, fieldLen);
  offset += fieldLen * 8;
  const ePhiReal = f64Plane(bytes, offset, fieldLen);
  offset += fieldLen * 8;
  const ePhiImag = f64Plane(bytes, offset, fieldLen);
  return {
    schemaVersion,
    nPorts,
    nTheta,
    nPhi,
    samplesPerPort,
    frequencyMHz: header.getFloat64(32, true),
    radiusM: header.getFloat64(40, true),
    modelGeneration: header.getBigUint64(48, true),
    thetaDeg,
    phiDeg,
    eThetaReal,
    eThetaImag,
    ePhiReal,
    ePhiImag,
    sampleIndex(port, thetaIndex, phiIndex) {
      return port * samplesPerPort + phiIndex * nTheta + thetaIndex;
    },
  };
}

export function matrixToJson(matrix) {
  return {
    rows: matrix.rows,
    columns: matrix.columns,
    order: matrix.order,
    real: Array.from(matrix.real),
    imag: Array.from(matrix.imag),
  };
}

export function relativeError(left, right) {
  if (left.length !== right.length) {
    throw new Error("relativeError length mismatch");
  }
  let numerator = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const delta = left[index] - right[index];
    numerator += delta * delta;
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  return Math.sqrt(numerator)
    / Math.max(1, Math.sqrt(leftNorm), Math.sqrt(rightNorm));
}

export function complexRelativeError(left, right) {
  return relativeError(
    Float64Array.from([...left.real, ...left.imag]),
    Float64Array.from([...right.real, ...right.imag]),
  );
}

export {
  NECQ_HEADER_BYTES,
  NECF_HEADER_BYTES,
  NECQ_FLAG_IMAGES,
  NECQ_FLAG_WEIGHTS,
};
