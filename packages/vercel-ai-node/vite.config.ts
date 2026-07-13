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
        "@ai-sdk/mcp",
        "@tilde/harness-sdk",
        "ai",
        "node:child_process",
        "node:crypto",
        "node:async_hooks",
        "node:fs",
        "node:http",
        "node:net",
        "node:os",
        "node:path",
        "node:readline",
      ],
    },
    sourcemap: true,
    target: "node20",
  },
  plugins: [dts({ insertTypesEntry: true })],
});
