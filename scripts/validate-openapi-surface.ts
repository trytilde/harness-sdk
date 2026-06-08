import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const specPath = resolve(root, "specs/openapi.cloud.json");

const requiredOperations = [
  "create-mcp-server-instance",
  "list-mcp-server-instances",
  "get-mcp-server-instance",
  "add-mcp-server-instance-function",
  "list-tool-deployments-by-alias",
  "list-available-tool-groups",
  "create-tool-group-instance",
  "ai_gateway_list_profiles",
  "ai_gateway_create_profile",
  "ai_gateway_get_profile",
  "ai_gateway_delete_profile",
  "ai_gateway_update_profile",
  "ai_gateway_list_providers",
  "list-messages",
  "get-session-event-history",
];

const spec = JSON.parse(await readFile(specPath, "utf8")) as {
  paths?: Record<string, Record<string, { operationId?: string }>>;
};

const operations = new Set<string>();
for (const path of Object.values(spec.paths ?? {})) {
  for (const operation of Object.values(path)) {
    if (operation.operationId) {
      operations.add(operation.operationId);
    }
  }
}

const missingRequired = requiredOperations.filter((op) => !operations.has(op));
if (missingRequired.length > 0) {
  console.error("Missing required OpenAPI operations:");
  for (const operation of missingRequired) {
    console.error(`- ${operation}`);
  }
  process.exit(1);
}

console.log(`Validated ${operations.size} OpenAPI operations`);
