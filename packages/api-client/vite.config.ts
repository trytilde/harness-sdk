import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";
import { nodeEsmDeclarations } from "../../scripts/vite-dts";

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: "src/index.ts",
        "generated/index": "src/generated/index.ts",
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      external: ["@hey-api/client-fetch"],
    },
    sourcemap: true,
    target: "es2022",
  },
  plugins: [
    dts({
      ...nodeEsmDeclarations(fileURLToPath(new URL(".", import.meta.url))),
      entryRoot: "src",
      include: ["src"],
      insertTypesEntry: true,
    }),
  ],
});
