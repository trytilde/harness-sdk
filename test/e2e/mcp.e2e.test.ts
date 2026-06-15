import {
  createMCPClient,
  type TildeMCPClient,
} from "@tilde/harness-sdk-vercel-ai-node";
import { jsonSchema, type ToolSet, tool } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createE2EClient } from "./helpers/env";
import {
  createDebugMcpFixture,
  DEBUG_HELLO_WORLD_TOOL_TYPE_ID,
  DEBUG_TOOL_GROUP_SOURCE_TYPE_ID,
  GET_TOOL_SCHEMAS_NAME,
  type McpFixture,
  MULTI_EXECUTE_TOOL_NAME,
  SEARCH_TOOLS_NAME,
} from "./helpers/mcp-fixtures";

const toolExecutionOptions = () => ({
  toolCallId: `sdk-e2e-${Date.now()}`,
  messages: [],
  abortSignal: new AbortController().signal,
});

describe("MCP e2e", () => {
  const fixtures: McpFixture[] = [];
  const mcpClients: TildeMCPClient[] = [];

  afterEach(async () => {
    for (const mcp of mcpClients.splice(0).reverse()) {
      await mcp.close();
    }
    for (const fixture of fixtures.splice(0).reverse()) {
      await fixture.cleanup();
    }
  });

  it("invokes a debug provider tool through a static MCP server", async () => {
    const client = createE2EClient();
    const fixture = await createDebugMcpFixture(client, {
      name: "static-remote",
      isDynamicToolDiscovery: false,
    });
    fixtures.push(fixture);

    const mcp = await createMCPClient({
      client,
      serverId: fixture.serverId,
    });
    mcpClients.push(mcp);

    const tools = await mcp.tools();
    expect(tools).toHaveProperty(DEBUG_HELLO_WORLD_TOOL_TYPE_ID);

    const result = await executeTool(tools[DEBUG_HELLO_WORLD_TOOL_TYPE_ID], {
      name: "SDK e2e",
    });

    expect(structuredOutput(result)).toMatchObject({
      message: "Hello, SDK e2e!",
      echoed_name: "SDK e2e",
      provider: DEBUG_TOOL_GROUP_SOURCE_TYPE_ID,
    });
  });

  it("searches and invokes a debug provider tool through dynamic MCP mode", async () => {
    const client = createE2EClient();
    const fixture = await createDebugMcpFixture(client, {
      name: "dynamic-remote",
      isDynamicToolDiscovery: true,
    });
    fixtures.push(fixture);

    const mcp = await createMCPClient({
      client,
      serverId: fixture.serverId,
    });
    mcpClients.push(mcp);

    const tools = await mcp.tools();
    expect(Object.keys(tools).sort()).toEqual([
      GET_TOOL_SCHEMAS_NAME,
      MULTI_EXECUTE_TOOL_NAME,
      SEARCH_TOOLS_NAME,
    ]);

    const searchResult = structuredOutput(
      await executeTool(tools[SEARCH_TOOLS_NAME], {
        use_case: "Say hello with the debug playground tool",
        max_results: 5,
        include_schemas: true,
      }),
    );
    expect(searchResult.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool_name: DEBUG_HELLO_WORLD_TOOL_TYPE_ID,
        }),
      ]),
    );

    const schemasResult = structuredOutput(
      await executeTool(tools[GET_TOOL_SCHEMAS_NAME], {
        tool_names: [DEBUG_HELLO_WORLD_TOOL_TYPE_ID],
      }),
    );
    expect(schemasResult.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool_name: DEBUG_HELLO_WORLD_TOOL_TYPE_ID,
        }),
      ]),
    );

    const multiResult = structuredOutput(
      await executeTool(tools[MULTI_EXECUTE_TOOL_NAME], {
        invocations: [
          {
            tool_name: DEBUG_HELLO_WORLD_TOOL_TYPE_ID,
            parameters: { name: "SDK e2e" },
          },
        ],
      }),
    );
    expect(multiResult.results).toEqual([
      expect.objectContaining({
        tool_name: DEBUG_HELLO_WORLD_TOOL_TYPE_ID,
        success: true,
        output: expect.objectContaining({
          message: "Hello, SDK e2e!",
          echoed_name: "SDK e2e",
          provider: DEBUG_TOOL_GROUP_SOURCE_TYPE_ID,
        }),
      }),
    ]);
  });

  it("merges local Vercel AI tools with a static MCP server", async () => {
    const client = createE2EClient();
    const fixture = await createDebugMcpFixture(client, {
      name: "static-local",
      isDynamicToolDiscovery: false,
    });
    fixtures.push(fixture);

    const localEcho = tool({
      description: "Echo a local SDK e2e value",
      inputSchema: jsonSchema<{ value?: string }>({
        type: "object",
        properties: {
          value: { type: "string" },
        },
      }),
      async execute(input: { value?: string }) {
        return {
          local: true,
          echoed: input.value ?? null,
        };
      },
    });

    const mcp = await createMCPClient({
      client,
      serverId: fixture.serverId,
      tools: {
        localEcho,
      } as unknown as ToolSet,
    });
    mcpClients.push(mcp);

    const tools = await mcp.tools();
    expect(tools).toHaveProperty(DEBUG_HELLO_WORLD_TOOL_TYPE_ID);
    expect(tools).toHaveProperty("localEcho");

    await expect(
      mcp.callTool("localEcho", { value: "local" }),
    ).resolves.toEqual({
      local: true,
      echoed: "local",
    });
  });
});

async function executeTool(
  toolDefinition: unknown,
  input: Record<string, unknown>,
) {
  const executable = toolDefinition as {
    execute?: (
      input: Record<string, unknown>,
      options: unknown,
    ) => Promise<unknown>;
  };
  if (typeof executable.execute !== "function") {
    throw new TypeError("MCP tool is not executable");
  }
  return executable.execute(input, toolExecutionOptions());
}

function structuredOutput(result: unknown): Record<string, unknown> {
  if (isRecord(result) && isRecord(result.structuredContent)) {
    return result.structuredContent;
  }
  if (isRecord(result) && Array.isArray(result.content)) {
    for (const part of result.content) {
      if (
        isRecord(part) &&
        part.type === "text" &&
        typeof part.text === "string"
      ) {
        const parsed = JSON.parse(part.text);
        if (isRecord(parsed)) {
          return parsed;
        }
      }
    }
  }
  if (isRecord(result)) {
    return result;
  }
  throw new TypeError("MCP tool result did not contain structured output");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
