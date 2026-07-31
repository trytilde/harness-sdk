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
        "@trytilde/harness-sdk",
        "@trytilde/harness-sdk-react",
        "react",
      ],
    },
    sourcemap: true,
    target: "es2022",
  },
  plugins: [dts({ insertTypesEntry: true })],
});
