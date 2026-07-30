import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

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
  plugins: [dts({ insertTypesEntry: true })],
});
