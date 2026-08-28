import { defineConfig } from "vite";

export default defineConfig({
  build: { target: "es2024" },
  worker: { format: "es" },
});
