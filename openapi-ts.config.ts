import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "openapi.cloud.json",
  output: {
    path: "packages/api-client/src/generated",
    clean: true,
  },
  plugins: [
    "@hey-api/client-fetch",
    {
      name: "@hey-api/sdk",
      operations: {
        strategy: "flat",
      },
    },
    {
      name: "@hey-api/typescript",
      enums: "typescript",
    },
  ],
});
