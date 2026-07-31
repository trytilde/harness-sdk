import { ApiError, type Client } from "@trytilde/harness-sdk";

export const DEBUG_TOOL_GROUP_SOURCE_TYPE_ID = "debug_playground";
export const DEBUG_CREDENTIAL_SOURCE_TYPE_ID = "no_auth";
export const DEBUG_HELLO_WORLD_TOOL_TYPE_ID = "debug_hello_world";
export const DEBUG_DUMMY_CONTENT_TOOL_TYPE_ID = "debug_dummy_content";
export const SEARCH_TOOLS_NAME = "SEARCH_TOOLS";
export const GET_TOOL_SCHEMAS_NAME = "GET_TOOL_SCHEMAS";
export const MULTI_EXECUTE_TOOL_NAME = "MULTI_EXECUTE_TOOL";

export type McpFixture = {
  serverId: string;
  toolGroupInstanceId: string;
  cleanup(): Promise<void>;
};

export async function createDebugMcpFixture(
  client: Client,
  input: {
    name: string;
    isDynamicToolDiscovery: boolean;
  },
): Promise<McpFixture> {
  const suffix = safeId(`${input.name}-${Date.now()}`);
  const serverId = `sdk-e2e-${suffix}-server`;
  const toolGroupInstanceId = `sdk-e2e-${suffix}-debug`;

  await client.mcp.createToolGroup({
    toolGroupSourceTypeId: DEBUG_TOOL_GROUP_SOURCE_TYPE_ID,
    credentialSourceTypeId: DEBUG_CREDENTIAL_SOURCE_TYPE_ID,
    toolGroupInstanceId,
    displayName: `SDK e2e ${input.name}`,
  });

  await client.mcp.createServer({
    id: serverId,
    name: `SDK e2e ${input.name}`,
    isDynamicToolDiscovery: input.isDynamicToolDiscovery,
  });

  for (const toolName of [
    DEBUG_HELLO_WORLD_TOOL_TYPE_ID,
    DEBUG_DUMMY_CONTENT_TOOL_TYPE_ID,
  ]) {
    await client.mcp.enableTool({
      toolGroupInstanceId,
      toolSourceTypeId: toolName,
    });

    await client.mcp.addFunction({
      serverId,
      toolSourceTypeId: toolName,
      toolGroupSourceTypeId: DEBUG_TOOL_GROUP_SOURCE_TYPE_ID,
      toolGroupInstanceId,
      toolName,
    });
  }

  return {
    serverId,
    toolGroupInstanceId,
    async cleanup() {
      await ignoreNotFound(() => client.mcp.deleteServer({ id: serverId }));
      await ignoreNotFound(() =>
        client.mcp.deleteToolGroup({ id: toolGroupInstanceId }),
      );
    },
  };
}

async function ignoreNotFound(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return;
    }
    throw error;
  }
}

function safeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
