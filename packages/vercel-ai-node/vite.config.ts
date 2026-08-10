import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";
import { nodeEsmDeclarations } from "../../scripts/vite-dts";

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
        "@trytilde/harness-sdk",
        "ai",
        "zod",
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
