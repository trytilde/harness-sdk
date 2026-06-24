import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      external: [
        "@tilde/harness-sdk",
        "node:fs/promises",
        "node:path",
        "node:process",
        "node:url",
        "tsx/esm/api",
      ],
    },
    sourcemap: true,
    target: "es2022",
  },
  plugins: [dts({ insertTypesEntry: true })],
});
