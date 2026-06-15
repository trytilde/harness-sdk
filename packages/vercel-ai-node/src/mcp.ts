import {
  createMCPClient as createVercelMCPClient,
  type MCPClient,
  type MCPClientConfig,
} from "@ai-sdk/mcp";
import type { Client, JsonObject, LocalMcpTool } from "@tilde/harness-sdk";
import { wrapMcpClientWithLocalTools } from "@tilde/harness-sdk";
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

export type TildeMCPClient<TTools extends ToolSet = ToolSet> = MCPClient & {
  readonly serverId: string;
  readonly localTools: readonly LocalMcpTool[];
  callTool(name: string, input?: JsonObject): Promise<unknown>;
  tools(): Promise<TTools & Awaited<ReturnType<MCPClient["tools"]>>>;
};

export async function createMCPClient<TTools extends ToolSet = ToolSet>(
  options: CreateMCPClientOptions<TTools>,
): Promise<TildeMCPClient<TTools>> {
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
    tools: toLocalTools(options.tools ?? ({} as TTools)),
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
  const localTool: LocalMcpTool = {
    name,
    description: tool.description ?? name,
    inputSchema: tool.inputSchema as JsonObject,
    async execute(input, _context) {
      return tool.execute?.(input, {
        toolCallId: `${name}-local`,
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
