import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";
import { nodeEsmDeclarations } from "../../scripts/vite-dts";

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: "src/index.ts",
        api: "src/api.ts",
      },
      formats: ["es"],
      fileName: (_, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: ["nice-grpc"],
    },
    sourcemap: true,
    target: "es2022",
  },
  plugins: [
    dts({
      ...nodeEsmDeclarations(fileURLToPath(new URL(".", import.meta.url))),
      aliasesExclude: [/^@trytilde\//],
      entryRoot: "src",
      include: ["src"],
      insertTypesEntry: true,
    }),
  ],
});
