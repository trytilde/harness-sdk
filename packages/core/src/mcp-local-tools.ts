export type JsonObject = Record<string, unknown>;

export type LocalMcpToolContext = {
  callTool(name: string, input?: JsonObject): Promise<unknown>;
  callLocalTool(name: string, input?: JsonObject): Promise<unknown>;
  callRemoteTool(name: string, input?: JsonObject): Promise<unknown>;
};

export type LocalMcpTool = {
  name: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  execute(input: JsonObject, context: LocalMcpToolContext): Promise<unknown>;
};

export type McpClientLike = {
  tools?: () => Promise<Record<string, unknown>>;
  callTool?: (name: string, input?: JsonObject) => Promise<unknown>;
  close?: () => Promise<void> | void;
};

export type LocalMcpToolWrapperOptions<TClient extends object> = {
  client: TClient;
  serverId: string;
  tools: LocalMcpTool[];
  registerWithServer?: boolean;
};

export type ToolInvocationRequest = {
  tool_name: string;
  parameters?: JsonObject;
};

export type ToolInvocationResult = {
  tool_name: string;
  success: boolean;
  output?: unknown;
  error?: string;
};

export type MultiExecuteToolRequest = {
  invocations: ToolInvocationRequest[];
};

export type MultiExecuteToolResult = {
  results: ToolInvocationResult[];
};

export type LocalMcpToolsClient<TClient extends object> = TClient & {
  readonly serverId: string;
  readonly localTools: readonly LocalMcpTool[];
  tools(): Promise<Record<string, unknown>>;
  callTool(name: string, input?: JsonObject): Promise<unknown>;
  close(): Promise<void>;
};

export const MULTI_EXECUTE_TOOL_NAME = "MULTI_EXECUTE_TOOL";

const RESERVED_TOOL_NAMES = new Set([
  "SEARCH_TOOLS",
  "GET_TOOL_SCHEMAS",
  MULTI_EXECUTE_TOOL_NAME,
]);

type LocalToolEntry = {
  tool: LocalMcpTool;
  key: string;
};

export function wrapMcpClientWithLocalTools<TClient extends object>(
  options: LocalMcpToolWrapperOptions<TClient>,
): LocalMcpToolsClient<TClient> {
  validateWrapperOptions(options);
  const localTools = options.tools.map((tool) => ({
    tool,
    key: normalizeToolName(tool.name),
  }));
  const byName = new Map(localTools.map((entry) => [entry.key, entry]));
  const client = options.client as TClient & McpClientLike;

  if (options.registerWithServer) {
    throw new TypeError(
      "Server-side local tool registration is not available in this SDK version",
    );
  }

  const wrapper = Object.create(client) as LocalMcpToolsClient<TClient>;

  const callRemoteTool = async (
    name: string,
    input?: JsonObject,
  ): Promise<unknown> => {
    if (!client.callTool) {
      throw new TypeError("Wrapped MCP client does not expose callTool");
    }
    return client.callTool(name, input);
  };

  const callLocalTool = async (
    name: string,
    input?: JsonObject,
  ): Promise<unknown> => {
    const entry = byName.get(normalizeToolName(name));
    if (!entry) {
      throw new TypeError(`Unknown local MCP tool: ${name}`);
    }
    return entry.tool.execute(input ?? {}, context);
  };

  const callTool = async (
    name: string,
    input?: JsonObject,
  ): Promise<unknown> => {
    if (normalizeToolName(name) === MULTI_EXECUTE_TOOL_NAME) {
      return routeMultiExecute(input, byName, context, callRemoteTool);
    }
    const entry = byName.get(normalizeToolName(name));
    if (entry) {
      return entry.tool.execute(input ?? {}, context);
    }
    return callRemoteTool(name, input);
  };

  const context: LocalMcpToolContext = {
    callTool,
    callLocalTool,
    callRemoteTool,
  };

  Object.defineProperties(wrapper, {
    serverId: {
      enumerable: true,
      value: options.serverId,
    },
    localTools: {
      enumerable: true,
      value: options.tools.slice(),
    },
    tools: {
      enumerable: true,
      value: async () => {
        const remoteTools = client.tools ? await client.tools() : {};
        return mergeLocalTools(remoteTools, localTools, context);
      },
    },
    callTool: {
      enumerable: true,
      value: callTool,
    },
    close: {
      enumerable: true,
      value: async () => {
        await client.close?.();
      },
    },
  });

  return wrapper;
}

function validateWrapperOptions<TClient extends object>(
  options: LocalMcpToolWrapperOptions<TClient>,
): void {
  if (!options.client || typeof options.client !== "object") {
    throw new TypeError("client is required");
  }
  if (!options.serverId || options.serverId.trim().length === 0) {
    throw new TypeError("serverId is required");
  }
  const seen = new Set<string>();
  for (const tool of options.tools) {
    validateLocalTool(tool);
    const key = normalizeToolName(tool.name);
    if (seen.has(key)) {
      throw new TypeError(`Duplicate local MCP tool name: ${tool.name}`);
    }
    seen.add(key);
  }
}

function validateLocalTool(tool: LocalMcpTool): void {
  if (!tool.name || tool.name.trim().length === 0) {
    throw new TypeError("Local MCP tool name is required");
  }
  const normalized = normalizeToolName(tool.name);
  if (RESERVED_TOOL_NAMES.has(normalized)) {
    throw new TypeError(`Local MCP tool name is reserved: ${tool.name}`);
  }
  if (!tool.description || tool.description.trim().length === 0) {
    throw new TypeError(`Local MCP tool description is required: ${tool.name}`);
  }
  if (!isJsonObject(tool.inputSchema)) {
    throw new TypeError(
      `Local MCP tool inputSchema must be an object: ${tool.name}`,
    );
  }
  if (tool.outputSchema !== undefined && !isJsonObject(tool.outputSchema)) {
    throw new TypeError(
      `Local MCP tool outputSchema must be an object: ${tool.name}`,
    );
  }
  if (typeof tool.execute !== "function") {
    throw new TypeError(
      `Local MCP tool execute must be a function: ${tool.name}`,
    );
  }
}

function mergeLocalTools(
  remoteTools: Record<string, unknown>,
  localTools: LocalToolEntry[],
  context: LocalMcpToolContext,
): Record<string, unknown> {
  const merged = { ...remoteTools };
  const remoteNames = new Set(Object.keys(remoteTools).map(normalizeToolName));

  for (const entry of localTools) {
    if (remoteNames.has(entry.key)) {
      throw new TypeError(
        `Local MCP tool name collides with remote MCP tool: ${entry.tool.name}`,
      );
    }
    merged[entry.tool.name] = localToolToProviderTool(entry.tool, context);
  }

  return merged;
}

function localToolToProviderTool(
  tool: LocalMcpTool,
  context: LocalMcpToolContext,
): JsonObject {
  const providerTool: JsonObject = {
    description: tool.description,
    inputSchema: tool.inputSchema,
    parameters: tool.inputSchema,
    execute: async (input?: JsonObject) => tool.execute(input ?? {}, context),
  };
  if (tool.outputSchema !== undefined) {
    providerTool.outputSchema = tool.outputSchema;
  }
  return providerTool;
}

async function routeMultiExecute(
  input: JsonObject | undefined,
  localTools: Map<string, LocalToolEntry>,
  context: LocalMcpToolContext,
  callRemoteTool: (name: string, input?: JsonObject) => Promise<unknown>,
): Promise<MultiExecuteToolResult> {
  const request = parseMultiExecuteRequest(input);
  const results = new Array<ToolInvocationResult>(request.invocations.length);
  const remoteInvocations: ToolInvocationRequest[] = [];
  const remoteIndexes: number[] = [];

  const localPromises = request.invocations.map(async (invocation, index) => {
    const entry = localTools.get(normalizeToolName(invocation.tool_name));
    if (!entry) {
      remoteInvocations.push(invocation);
      remoteIndexes.push(index);
      return;
    }
    results[index] = await executeLocalInvocation(
      entry.tool,
      invocation,
      context,
    );
  });

  await Promise.all(localPromises);

  if (remoteInvocations.length > 0) {
    const normalized = await executeRemoteMultiExecute(
      remoteInvocations,
      callRemoteTool,
    );
    for (let i = 0; i < remoteIndexes.length; i += 1) {
      const result = normalized.results[i];
      const index = remoteIndexes[i];
      if (result === undefined || index === undefined) {
        continue;
      }
      results[index] = result;
    }
  }

  return {
    results: results.map((result, index) => {
      if (result) {
        return result;
      }
      const invocation = request.invocations[index];
      return {
        tool_name: invocation?.tool_name ?? "",
        success: false,
        error: "Tool invocation did not produce a result",
      };
    }),
  };
}

async function executeRemoteMultiExecute(
  remoteInvocations: ToolInvocationRequest[],
  callRemoteTool: (name: string, input?: JsonObject) => Promise<unknown>,
): Promise<MultiExecuteToolResult> {
  try {
    const remoteResult = await callRemoteTool(MULTI_EXECUTE_TOOL_NAME, {
      invocations: remoteInvocations,
    });
    return normalizeMultiExecuteResult(remoteResult, remoteInvocations);
  } catch (error) {
    return {
      results: remoteInvocations.map((invocation) => ({
        tool_name: invocation.tool_name,
        success: false,
        error: errorMessage(error),
      })),
    };
  }
}

function parseMultiExecuteRequest(
  input: JsonObject | undefined,
): MultiExecuteToolRequest {
  const invocations = input?.invocations;
  if (!Array.isArray(invocations)) {
    throw new TypeError("MULTI_EXECUTE_TOOL input must include invocations");
  }

  return {
    invocations: invocations.map((value, index) => {
      if (!isJsonObject(value)) {
        throw new TypeError(
          `MULTI_EXECUTE_TOOL invocation ${index} must be an object`,
        );
      }
      const toolName = value.tool_name;
      if (typeof toolName !== "string" || toolName.length === 0) {
        throw new TypeError(
          `MULTI_EXECUTE_TOOL invocation ${index} must include tool_name`,
        );
      }
      const parameters = value.parameters;
      if (parameters !== undefined && !isJsonObject(parameters)) {
        throw new TypeError(
          `MULTI_EXECUTE_TOOL invocation ${index} parameters must be an object`,
        );
      }
      const invocation: ToolInvocationRequest = { tool_name: toolName };
      if (parameters !== undefined) {
        invocation.parameters = parameters;
      }
      return invocation;
    }),
  };
}

async function executeLocalInvocation(
  tool: LocalMcpTool,
  invocation: ToolInvocationRequest,
  context: LocalMcpToolContext,
): Promise<ToolInvocationResult> {
  try {
    return {
      tool_name: invocation.tool_name,
      success: true,
      output: await tool.execute(invocation.parameters ?? {}, context),
    };
  } catch (error) {
    return {
      tool_name: invocation.tool_name,
      success: false,
      error: errorMessage(error),
    };
  }
}

function normalizeMultiExecuteResult(
  value: unknown,
  invocations: ToolInvocationRequest[],
): MultiExecuteToolResult {
  if (isJsonObject(value) && Array.isArray(value.results)) {
    return {
      results: value.results.map((result, index) =>
        normalizeInvocationResult(result, invocations[index]),
      ),
    };
  }

  if (invocations.length === 1) {
    return {
      results: [
        {
          tool_name: invocations[0]?.tool_name ?? "",
          success: true,
          output: value,
        },
      ],
    };
  }

  return {
    results: invocations.map((invocation) => ({
      tool_name: invocation.tool_name,
      success: false,
      error: "Remote MULTI_EXECUTE_TOOL returned an invalid result shape",
    })),
  };
}

function normalizeInvocationResult(
  value: unknown,
  invocation: ToolInvocationRequest | undefined,
): ToolInvocationResult {
  if (!isJsonObject(value)) {
    return {
      tool_name: invocation?.tool_name ?? "",
      success: false,
      error: "Remote tool invocation returned an invalid result shape",
    };
  }

  const success = value.success;
  const result: ToolInvocationResult = {
    tool_name:
      typeof value.tool_name === "string"
        ? value.tool_name
        : (invocation?.tool_name ?? ""),
    success: typeof success === "boolean" ? success : !value.error,
  };
  if ("output" in value) {
    result.output = value.output;
  }
  if (typeof value.error === "string") {
    result.error = value.error;
  }
  return result;
}

function normalizeToolName(name: string): string {
  return name.toUpperCase();
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
