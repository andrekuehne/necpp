import { finiteNumber, inputError, positiveNumber, requireRecord } from "./model.js";
import type { DielectricLayer, LayeredStack, LayeredStackBelow, LayeredStacks } from "./types.js";

function validLayer(value: unknown, name: string): DielectricLayer {
  const record = requireRecord(value, name);
  const thicknessM = positiveNumber(record.thicknessM, `${name}.thicknessM`);
  const relativePermittivity = finiteNumber(record.relativePermittivity, `${name}.relativePermittivity`);
  if (!(relativePermittivity >= 1)) {
    inputError(`${name}.relativePermittivity must be at least 1`, {
      name: `${name}.relativePermittivity`,
      value: relativePermittivity,
    });
  }
  const lossTangent = record.lossTangent === undefined
    ? 0
    : finiteNumber(record.lossTangent, `${name}.lossTangent`);
  if (!(lossTangent >= 0)) {
    inputError(`${name}.lossTangent must not be negative`, { name: `${name}.lossTangent`, value: lossTangent });
  }
  return Object.freeze({ thicknessM, relativePermittivity, lossTangent });
}

function validLayers(record: Record<string, unknown>, name: string): readonly DielectricLayer[] {
  if (!Array.isArray(record.layers) || record.layers.length === 0) {
    inputError(`${name}.layers must be a non-empty array of layers`, { name: `${name}.layers` });
  }
  return Object.freeze((record.layers as readonly unknown[]).map((layer, index) =>
    validLayer(layer, `${name}.layers[${index}]`)));
}

function validStackAbove(value: unknown, name: string): LayeredStack {
  const record = requireRecord(value, name);
  const bottomZM = finiteNumber(record.bottomZM, `${name}.bottomZM`);
  return Object.freeze({ bottomZM, layers: validLayers(record, name) });
}

function validStackBelow(value: unknown, name: string): LayeredStackBelow {
  const record = requireRecord(value, name);
  const topZM = finiteNumber(record.topZM, `${name}.topZM`);
  return Object.freeze({ topZM, layers: validLayers(record, name) });
}

/** @internal Layered stacks, validated and copied. */
export function validLayeredStacks(value: unknown, name: string): LayeredStacks {
  const record = requireRecord(value, name);
  for (const key of Object.keys(record)) {
    if (key !== "above" && key !== "below") {
      inputError(`${name}.${key} is not a layered stack; use "above" or "below"`, { name: `${name}.${key}` });
    }
  }
  return Object.freeze({
    ...(record.above === undefined ? {} : { above: validStackAbove(record.above, `${name}.above`) }),
    ...(record.below === undefined ? {} : { below: validStackBelow(record.below, `${name}.below`) }),
  });
}
