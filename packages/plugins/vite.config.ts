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
        "@inquirer/checkbox",
        "@trytilde/harness-sdk",
        "@trytilde/harness-sdk/api",
      ],
    },
    sourcemap: true,
    target: "es2022",
  },
  plugins: [dts({ insertTypesEntry: true })],
});
