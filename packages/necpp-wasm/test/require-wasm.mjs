import { existsSync } from "node:fs";

const missing = ["nec2pp.generated.js", "nec2pp.wasm"].filter(
  (name) => !existsSync(new URL(`../src/${name}`, import.meta.url)),
);

if (missing.length > 0) {
  throw new Error(
    `WASM facade acceptance requires built artifacts: ${missing.join(", ")}`,
  );
}
