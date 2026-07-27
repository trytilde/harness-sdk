import { randomUUID } from "node:crypto";
import {
  createMCPClient as createVercelMCPClient,
  type MCPClient,
  type MCPClientConfig,
} from "@ai-sdk/mcp";
import type {
  Client,
  JsonObject,
  LocalMcpTool,
  ToolRegistry,
  ToolResult,
} from "@tilde/harness-sdk";
import { configHeaders, wrapMcpClientWithLocalTools } from "@tilde/harness-sdk";
import type { ToolExecutionOptions, ToolSet } from "ai";

export type CreateMCPClientOptions<TTools extends ToolSet = ToolSet> = Omit<
  MCPClientConfig,
  "transport"
> & {
  client: Client;
  serverId: string;
  tools?: TTools;
  headers?: Record<string, string>;
};

export type TildeMCPClient<TTools extends ToolSet = ToolSet> = Omit<
  MCPClient,
  "tools"
> & {
  readonly serverId: string;
  readonly localTools: readonly LocalMcpTool[];
  callTool<TResult extends ToolResult = ToolResult>(
    name: string,
    input?: JsonObject,
  ): Promise<TResult>;
  tools(): Promise<ToolRegistry & TTools>;
};

export async function createMCPClient<TTools extends ToolSet = ToolSet>(
  options: CreateMCPClientOptions<TTools>,
): Promise<TildeMCPClient<TTools>> {
  const apiKey = options.client.config.apiKey;
  if (!apiKey) {
    throw new TypeError("createMCPClient requires client config apiKey");
  }

  const clientHeaders = Object.fromEntries(
    configHeaders(options.client.config).entries(),
  );
  delete clientHeaders.authorization;
  const remoteClient = await createVercelMCPClient({
    ...options,
    transport: {
      type: "http",
      url: options.client.mcp.getServerUrl({ id: options.serverId }),
      headers: {
        ...clientHeaders,
        ...options.headers,
        "x-api-key": apiKey,
      },
      ...(options.client.config.fetch
        ? { fetch: options.client.config.fetch }
        : {}),
    },
  });

  return wrapMcpClientWithLocalTools({
    client: remoteClient,
    serverId: options.serverId,
    tools: toLocalTools(options.tools ?? ({} as TTools)),
  }) as TildeMCPClient<TTools>;
}

function toLocalTools(tools: ToolSet): LocalMcpTool[] {
  return Object.entries(tools).map(([name, tool]) => toLocalTool(name, tool));
}

type ExecutableToolLike = {
  description?: string;
  inputSchema?: JsonObject;
  outputSchema?: JsonObject;
  execute?: (
    input: JsonObject,
    options: ToolExecutionOptions,
  ) => ToolResult | Promise<ToolResult>;
};

function toLocalTool(name: string, value: ToolSet[string]): LocalMcpTool {
  const tool = value as unknown as ExecutableToolLike;
  if (typeof tool.execute !== "function") {
    throw new TypeError(`Local MCP tool requires execute: ${name}`);
  }
  const execute = tool.execute;
  const localTool: LocalMcpTool = {
    name,
    description: tool.description ?? name,
    inputSchema: jsonSchemaObject(tool.inputSchema),
    async execute(input, _context) {
      return (await execute(input, {
        toolCallId: `${name}-${randomUUID()}`,
        messages: [],
        abortSignal: new AbortController().signal,
      })) as ToolResult;
    },
  };
  if (tool.outputSchema !== undefined) {
    localTool.outputSchema = jsonSchemaObject(tool.outputSchema);
  }
  return localTool;
}

function jsonSchemaObject(schema: JsonObject | undefined): JsonObject {
  return schema && isJsonObject(schema) ? schema : { type: "object" };
}

function isJsonObject(value: ToolResult): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
