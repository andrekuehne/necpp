import { finiteNumber, inputError, positiveNumber, requireRecord } from "./model.js";
import type { DielectricLayer, LayeredStack, LayeredStacks } from "./types.js";

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

function validStack(value: unknown, name: string): LayeredStack {
  const record = requireRecord(value, name);
  const bottomZM = finiteNumber(record.bottomZM, `${name}.bottomZM`);
  if (!Array.isArray(record.layers) || record.layers.length === 0) {
    inputError(`${name}.layers must be a non-empty array of layers`, { name: `${name}.layers` });
  }
  const layers = (record.layers as readonly unknown[]).map((layer, index) =>
    validLayer(layer, `${name}.layers[${index}]`));
  return Object.freeze({ bottomZM, layers: Object.freeze(layers) });
}

/** @internal Layered stacks, validated and copied. */
export function validLayeredStacks(value: unknown, name: string): LayeredStacks {
  const record = requireRecord(value, name);
  for (const key of Object.keys(record)) {
    if (key !== "above") {
      inputError(`${name}.${key} is not a layered stack; only "above" is supported`, { name: `${name}.${key}` });
    }
  }
  return record.above === undefined
    ? Object.freeze({})
    : Object.freeze({ above: validStack(record.above, `${name}.above`) });
}
