import { randomUUID } from "node:crypto";
import {
  createMCPClient as createVercelMCPClient,
  type MCPClient,
  type MCPClientConfig,
} from "@ai-sdk/mcp";
import type { Client, JsonObject, LocalMcpTool } from "@tilde/harness-sdk";
import { wrapMcpClientWithLocalTools } from "@tilde/harness-sdk";
import type { ToolExecutionOptions, ToolSet } from "ai";

export type CreateMCPClientOptions<
  TTools extends Record<string, unknown> = ToolSet,
> = Omit<MCPClientConfig, "transport"> & {
  client: Client;
  serverId: string;
  tools?: TTools;
  headers?: Record<string, string>;
};

export type TildeMCPClient<TTools extends Record<string, unknown> = ToolSet> =
  Omit<MCPClient, "tools"> & {
    readonly serverId: string;
    readonly localTools: readonly LocalMcpTool[];
    callTool(name: string, input?: JsonObject): Promise<unknown>;
    tools(): Promise<Record<string, unknown> & TTools>;
  };

export async function createMCPClient<
  TTools extends Record<string, unknown> = ToolSet,
>(options: CreateMCPClientOptions<TTools>): Promise<TildeMCPClient<TTools>> {
  const apiKey = options.client.config.apiKey;
  if (!apiKey) {
    throw new TypeError("createMCPClient requires client config apiKey");
  }

  const remoteClient = await createVercelMCPClient({
    ...options,
    transport: {
      type: "http",
      url: options.client.mcp.getServerUrl({ id: options.serverId }),
      headers: {
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
    tools: toLocalTools((options.tools ?? {}) as ToolSet),
  }) as TildeMCPClient<TTools>;
}

function toLocalTools(tools: ToolSet): LocalMcpTool[] {
  return Object.entries(tools).map(([name, tool]) => toLocalTool(name, tool));
}

type ExecutableToolLike = {
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  execute?: (input: JsonObject, options: ToolExecutionOptions) => unknown;
};

function toLocalTool(name: string, value: unknown): LocalMcpTool {
  const tool = value as ExecutableToolLike;
  if (typeof tool.execute !== "function") {
    throw new TypeError(`Local MCP tool requires execute: ${name}`);
  }
  const execute = tool.execute;
  const localTool: LocalMcpTool = {
    name,
    description: tool.description ?? name,
    inputSchema: tool.inputSchema as JsonObject,
    async execute(input, _context) {
      return execute(input, {
        toolCallId: `${name}-${randomUUID()}`,
        messages: [],
        abortSignal: new AbortController().signal,
      });
    },
  };
  if (tool.outputSchema !== undefined) {
    localTool.outputSchema = tool.outputSchema as JsonObject;
  }
  return localTool;
}
