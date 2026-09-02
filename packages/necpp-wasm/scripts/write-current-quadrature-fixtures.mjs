import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  applyCurrentQuadratureFixture,
  currentQuadratureFieldGrid,
  currentQuadratureFixtures,
} from "../test/fixtures/current-quadrature.mjs";
import {
  matrixToJson,
  packedMagic,
  viewEmbeddedField,
  viewPreparedQuadrature,
} from "../test/fixtures/current-quadrature-packed.mjs";

export const CURRENT_QUADRATURE_FIXTURE_SCHEMA = "current-quadrature-v1";
export const FOUR_NODE_NODES = Object.freeze([-1, -1 / 3, 1 / 3, 1]);

const packageDirectory = dirname(fileURLToPath(import.meta.url));
export const fixtureDirectory = join(
  packageDirectory,
  "..",
  "fixtures",
  CURRENT_QUADRATURE_FIXTURE_SCHEMA,
);

const fourNodeQuadrature = Object.freeze({
  nodes: Float64Array.from(FOUR_NODE_NODES),
  images: "physical-only",
  modes: "unit-current",
});

function sha256(buffer) {
  return createHash("sha256").update(new Uint8Array(buffer)).digest("hex");
}

function resolveCreateNecModel() {
  const candidates = [
    new URL("../.test-build/src/index.js", import.meta.url),
    new URL("../dist/index.js", import.meta.url),
  ];
  for (const url of candidates) {
    const wasm = new URL("nec2pp.wasm", url);
    if (existsSync(fileURLToPath(url)) && existsSync(fileURLToPath(wasm))) {
      return url;
    }
  }
  return undefined;
}

function feedSegmentIndex(view, port) {
  for (let index = 0; index < view.nSegments; index += 1) {
    if (view.tag[index] === port.tag && view.segment[index] === port.segment) {
      return index;
    }
  }
  throw new Error(`feed segment ${port.tag}:${port.segment} was not found`);
}

function complexSample(real, imag) {
  return { re: real, im: imag };
}

function geometryJson(fixture) {
  return {
    id: fixture.id,
    wires: fixture.wires,
    ports: fixture.ports,
    groundConnection: fixture.groundConnection,
    ground: fixture.ground,
  };
}

async function characterizeFixture(createNecModel, fixture, images) {
  const model = await createNecModel();
  try {
    await applyCurrentQuadratureFixture(model, fixture);
    const characterization = model.characterizeIsolatedElement({
      quadrature: {
        ...fourNodeQuadrature,
        images,
      },
      field: currentQuadratureFieldGrid,
    });
    const currents = model.getCurrentDistribution({ kind: "unit-current" });
    return { characterization, currents };
  } finally {
    model.dispose();
  }
}

function representativeSamples(currents, necq, necf, fixture) {
  const feed = fixture.ports[0];
  const feedIndex = currents.segments.findIndex(
    (segment) => segment.tag === feed.tag && segment.segment === feed.segment,
  );
  if (feedIndex < 0) {
    throw new Error(`feed identity missing for ${fixture.id}`);
  }
  const packedFeed = feedSegmentIndex(necq, feed);
  const packedNode = 0;
  const packedCurrent = necq.currentIndex(0, 0, packedFeed, packedNode);
  const samples = {
    feedCentreCurrent: complexSample(
      currents.aReal[feedIndex] + currents.cReal[feedIndex],
      currents.aImag[feedIndex] + currents.cImag[feedIndex],
    ),
    quadratureFeedSample: {
      mode: 0,
      plane: 0,
      segmentIndex: packedFeed,
      node: packedNode,
      xi: FOUR_NODE_NODES[packedNode],
      current: complexSample(
        necq.iReal[packedCurrent],
        necq.iImag[packedCurrent],
      ),
      positionM: {
        x: necq.x[necq.geometryIndex(0, packedFeed, packedNode)],
        y: necq.y[necq.geometryIndex(0, packedFeed, packedNode)],
        z: necq.z[necq.geometryIndex(0, packedFeed, packedNode)],
      },
    },
  };
  if (necf !== undefined) {
    const thetaIndex = 1;
    const phiIndex = 1;
    const sample = necf.sampleIndex(0, thetaIndex, phiIndex);
    samples.fieldSample = {
      port: 0,
      thetaIndex,
      phiIndex,
      thetaDeg: necf.thetaDeg[thetaIndex],
      phiDeg: necf.phiDeg[phiIndex],
      eTheta: complexSample(necf.eThetaReal[sample], necf.eThetaImag[sample]),
      ePhi: complexSample(necf.ePhiReal[sample], necf.ePhiImag[sample]),
    };
  }
  return samples;
}

function packedRecord(name, buffer, extra = {}) {
  return {
    file: name,
    byteLength: buffer.byteLength,
    sha256: sha256(buffer),
    magic: packedMagic(buffer),
    ...extra,
  };
}

export async function buildCurrentQuadratureFixtures(createNecModel, versions) {
  const files = {};
  const cases = [];

  for (const fixture of Object.values(currentQuadratureFixtures)) {
    const { characterization, currents } = await characterizeFixture(
      createNecModel,
      fixture,
      "physical-only",
    );
    const necqName = `${fixture.id}.necq`;
    const necfName = `${fixture.id}.necf`;
    files[necqName] = characterization.quadrature.buffer;
    files[necfName] = characterization.embeddedField.buffer;
    const necq = viewPreparedQuadrature(characterization.quadrature.buffer);
    const necf = viewEmbeddedField(characterization.embeddedField.buffer);
    cases.push({
      id: fixture.id,
      geometry: geometryJson(fixture),
      frequencyMHz: currents.frequencyMHz,
      wavelengthM: currents.wavelengthM,
      quadrature: {
        nodes: [...FOUR_NODE_NODES],
        images: "physical-only",
        modes: "unit-current",
      },
      field: currentQuadratureFieldGrid,
      impedance: matrixToJson(characterization.impedance),
      admittance: matrixToJson(characterization.admittance),
      imagePolicy: "physical-only",
      units: {
        geometry: "metres",
        current: "ampere peak",
        convention: "exp(+j omega t)",
      },
      quadraturePacked: packedRecord(necqName, characterization.quadrature.buffer, {
        nSegments: necq.nSegments,
        nNodes: necq.nNodes,
        nModes: necq.nModes,
        nImagePlanes: necq.nImagePlanes,
      }),
      embeddedPacked: packedRecord(necfName, characterization.embeddedField.buffer, {
        nPorts: necf.nPorts,
        nTheta: necf.nTheta,
        nPhi: necf.nPhi,
        samplesPerPort: necf.samplesPerPort,
      }),
      samples: representativeSamples(currents, necq, necf, fixture),
    });
  }

  const monopole = currentQuadratureFixtures["rooted-monopole"];
  const imaged = await characterizeFixture(
    createNecModel,
    monopole,
    "perfect-ground-images",
  );
  const imageName = "rooted-monopole-images.necq";
  files[imageName] = imaged.characterization.quadrature.buffer;
  const imageView = viewPreparedQuadrature(imaged.characterization.quadrature.buffer);
  cases.push({
    id: "rooted-monopole-images",
    geometry: geometryJson(monopole),
    frequencyMHz: imaged.currents.frequencyMHz,
    wavelengthM: imaged.currents.wavelengthM,
    quadrature: {
      nodes: [...FOUR_NODE_NODES],
      images: "perfect-ground-images",
      modes: "unit-current",
    },
    field: currentQuadratureFieldGrid,
    impedance: matrixToJson(imaged.characterization.impedance),
    admittance: matrixToJson(imaged.characterization.admittance),
    imagePolicy: "perfect-ground-images",
    units: {
      geometry: "metres",
      current: "ampere peak",
      convention: "exp(+j omega t)",
    },
    quadraturePacked: packedRecord(
      imageName,
      imaged.characterization.quadrature.buffer,
      {
        nSegments: imageView.nSegments,
        nNodes: imageView.nNodes,
        nModes: imageView.nModes,
        nImagePlanes: imageView.nImagePlanes,
      },
    ),
    samples: representativeSamples(
      imaged.currents,
      imageView,
      undefined,
      monopole,
    ),
  });

  const { abiVersion, engineVersion, packageVersion } = versions;

  return {
    manifest: {
      schemaVersion: 1,
      fixtureSchema: CURRENT_QUADRATURE_FIXTURE_SCHEMA,
      abiVersion,
      engineVersion,
      packageVersion,
      cases,
    },
    files,
  };
}

export function writeCurrentQuadratureFixtures(bundle) {
  mkdirSync(fixtureDirectory, { recursive: true });
  writeFileSync(
    join(fixtureDirectory, "manifest.json"),
    `${JSON.stringify(bundle.manifest, null, 2)}\n`,
  );
  for (const [name, buffer] of Object.entries(bundle.files)) {
    writeFileSync(join(fixtureDirectory, name), Buffer.from(buffer));
  }
}

async function main() {
  const moduleUrl = resolveCreateNecModel();
  if (moduleUrl === undefined) {
    throw new Error(
      "WASM artifacts are missing; run npm --prefix packages/necpp-wasm run build:test first",
    );
  }
  const { createNecModel, abiVersion, engineVersion, packageVersion } =
    await import(moduleUrl.href);
  const bundle = await buildCurrentQuadratureFixtures(createNecModel, {
    abiVersion,
    engineVersion,
    packageVersion,
  });
  writeCurrentQuadratureFixtures(bundle);
  process.stdout.write(
    `wrote ${Object.keys(bundle.files).length} packed files to ${fixtureDirectory}\n`,
  );
}

const invoked = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invoked) {
  await main();
}
