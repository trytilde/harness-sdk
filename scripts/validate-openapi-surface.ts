import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const specPath = resolve(root, "specs/openapi.cloud.json");

const requiredOperations = [
  "create-mcp-server-instance",
  "list-mcp-server-instances",
  "get-mcp-server-instance",
  "add-mcp-server-instance-function",
  "list-messages",
  "get-session-event-history",
];

const expectedSoonOperations = [
  "chatkit-register-http-vercel-ai-sdk-agent",
  "chatkit-register-vercel-ui-channel",
  "chatkit-list-message-history",
  "chatkit-list-agents",
  "chatkit-list-channels",
  "chatkit-list-sessions",
  "ui-chat",
  "ui-chat-stream",
  "load-ui-chat-session",
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

const missingExpected = expectedSoonOperations.filter(
  (op) => !operations.has(op),
);
if (missingExpected.length > 0) {
  console.warn("Expected soon OpenAPI operations are not present yet:");
  for (const operation of missingExpected) {
    console.warn(`- ${operation}`);
  }
}

console.log(`Validated ${operations.size} OpenAPI operations`);
