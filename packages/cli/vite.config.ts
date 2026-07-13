import { builtinModules } from "node:module";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: "src/index.ts",
        cli: "src/cli.ts",
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: [
        ...builtinModules,
        ...builtinModules.map((name) => `node:${name}`),
        "@tilde/harness-sdk",
        "ink",
        "react",
      ],
    },
    sourcemap: true,
    target: "node20",
  },
  plugins: [dts({ exclude: ["test/**"], insertTypesEntry: true })],
});
