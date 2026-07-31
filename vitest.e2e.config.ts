import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@trytilde/harness-sdk": `${root}packages/core/src/index.ts`,
      "@trytilde/cli": `${root}packages/cli/src/index.ts`,
      "@trytilde/harness-sdk-react": `${root}packages/react/src/index.ts`,
      "@trytilde/harness-sdk-vercel-ai-node": `${root}packages/vercel-ai-node/src/index.ts`,
      "@trytilde/harness-sdk-vercel-ai-react": `${root}packages/vercel-ai-react/src/index.ts`,
    },
  },
  test: {
    globals: false,
    environment: "node",
    include: ["test/e2e/**/*.test.ts"],
    hookTimeout: 120_000,
    testTimeout: 120_000,
    sequence: {
      concurrent: false,
    },
  },
});
