export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[] | undefined;
export type JsonObject = { [key: string]: JsonValue };
export type ToolResult = JsonValue | undefined;

export type McpRequest = {
  method: string;
  params?: JsonValue;
};

export type ProviderToolDefinition = {
  description?: string;
  inputSchema?: JsonObject;
  parameters?: JsonObject;
  outputSchema?: JsonObject;
  execute?: (input?: JsonObject) => ToolResult | Promise<ToolResult>;
};

export type ToolRegistry<TTool = ProviderToolDefinition> = Record<
  string,
  TTool
>;

export type LocalMcpToolContext = {
  callTool<TResult extends ToolResult = ToolResult>(
    name: string,
    input?: JsonObject,
  ): Promise<TResult>;
  callLocalTool<TResult extends ToolResult = ToolResult>(
    name: string,
    input?: JsonObject,
  ): Promise<TResult>;
  callRemoteTool<TResult extends ToolResult = ToolResult>(
    name: string,
    input?: JsonObject,
  ): Promise<TResult>;
};

export type LocalMcpTool<TResult extends ToolResult = ToolResult> = {
  name: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  execute(input: JsonObject, context: LocalMcpToolContext): Promise<TResult>;
};

export type McpClientLike = {
  tools?: () => Promise<ToolRegistry>;
  callTool?: <TResult extends ToolResult = ToolResult>(
    name: string,
    input?: JsonObject,
  ) => Promise<TResult>;
  request?: (request: McpRequest, options?: JsonValue) => Promise<ToolResult>;
  close?: () => Promise<void> | void;
};

export type RegisterLocalMcpToolsRequest = {
  tools: Array<{
    name: string;
    display_name?: string;
    description: string;
    input_schema: JsonObject;
    output_schema?: JsonObject;
  }>;
};

export type LocalMcpToolWrapperOptions<TClient extends object> = {
  client: TClient;
  serverId: string;
  tools: LocalMcpTool[];
  registerWithServer?: boolean;
  registerLocalTools?: (
    request: RegisterLocalMcpToolsRequest,
  ) => Promise<ToolResult>;
};

export type ToolInvocationRequest = {
  tool_name: string;
  parameters?: JsonObject;
};

export type ToolInvocationResult = JsonObject & {
  tool_name: string;
  success: boolean;
  output?: ToolResult;
  error?: string;
};

export type MultiExecuteToolRequest = {
  invocations: ToolInvocationRequest[];
};

export type MultiExecuteToolResult = JsonObject & {
  results: ToolInvocationResult[];
};

export type LocalMcpToolsClient<TClient extends object> = TClient & {
  readonly serverId: string;
  readonly localTools: readonly LocalMcpTool[];
  tools(): Promise<ToolRegistry>;
  callTool<TResult extends ToolResult = ToolResult>(
    name: string,
    input?: JsonObject,
  ): Promise<TResult>;
  close(): Promise<void>;
};

export const MULTI_EXECUTE_TOOL_NAME = "MULTI_EXECUTE_TOOL";
export const SEARCH_TOOLS_NAME = "SEARCH_TOOLS";
export const GET_TOOL_SCHEMAS_NAME = "GET_TOOL_SCHEMAS";
export const REGISTER_LOCAL_TOOLS_METHOD = "tilde/localTools.register";

const RESERVED_TOOL_NAMES = new Set([
  SEARCH_TOOLS_NAME,
  GET_TOOL_SCHEMAS_NAME,
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
  let registrationPromise: Promise<ToolResult> | undefined;

  const wrapper = Object.create(client) as LocalMcpToolsClient<TClient>;

  const callRemoteTool = async <TResult extends ToolResult = ToolResult>(
    name: string,
    input?: JsonObject,
  ): Promise<TResult> => {
    if (!client.callTool) {
      throw new TypeError("Wrapped MCP client does not expose callTool");
    }
    return client.callTool(name, input);
  };

  const callLocalTool = async <TResult extends ToolResult = ToolResult>(
    name: string,
    input?: JsonObject,
  ): Promise<TResult> => {
    const entry = byName.get(normalizeToolName(name));
    if (!entry) {
      throw new TypeError(`Unknown local MCP tool: ${name}`);
    }
    return entry.tool.execute(input ?? {}, context) as Promise<TResult>;
  };

  const callTool = async <TResult extends ToolResult = ToolResult>(
    name: string,
    input?: JsonObject,
  ): Promise<TResult> => {
    await ensureServerRegistration();
    if (normalizeToolName(name) === SEARCH_TOOLS_NAME) {
      return (await routeSearchTools(
        input,
        localTools,
        callRemoteTool,
      )) as TResult;
    }
    if (normalizeToolName(name) === GET_TOOL_SCHEMAS_NAME) {
      return (await routeGetToolSchemas(
        input,
        localTools,
        callRemoteTool,
      )) as TResult;
    }
    if (normalizeToolName(name) === MULTI_EXECUTE_TOOL_NAME) {
      return typedToolResult<TResult>(
        await routeMultiExecute(input, byName, context, callRemoteTool),
      );
    }
    const entry = byName.get(normalizeToolName(name));
    if (entry) {
      return entry.tool.execute(input ?? {}, context) as Promise<TResult>;
    }
    return callRemoteTool(name, input);
  };

  const context: LocalMcpToolContext = {
    callTool,
    callLocalTool,
    callRemoteTool,
  };

  const ensureServerRegistration = async (): Promise<void> => {
    if (!options.registerWithServer) {
      return;
    }
    registrationPromise ??= registerLocalToolsWithServer(
      options,
      client,
      localTools,
    ).catch((error: unknown) => {
      registrationPromise = undefined;
      throw error;
    });
    await registrationPromise;
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
        await ensureServerRegistration();
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

async function registerLocalToolsWithServer<TClient extends object>(
  options: LocalMcpToolWrapperOptions<TClient>,
  client: TClient & McpClientLike,
  localTools: LocalToolEntry[],
): Promise<ToolResult> {
  const request: RegisterLocalMcpToolsRequest = {
    tools: localTools.map(({ tool }) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
      ...(tool.outputSchema ? { output_schema: tool.outputSchema } : {}),
    })),
  };
  if (options.registerLocalTools) {
    return options.registerLocalTools(request);
  }
  if (client.request) {
    return client.request({
      method: REGISTER_LOCAL_TOOLS_METHOD,
      params: request,
    });
  }
  throw new TypeError(
    "registerWithServer requires registerLocalTools or an MCP client request method",
  );
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
  remoteTools: ToolRegistry,
  localTools: LocalToolEntry[],
  context: LocalMcpToolContext,
): ToolRegistry {
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
): ProviderToolDefinition {
  const providerTool: ProviderToolDefinition = {
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
  callRemoteTool: <TResult extends ToolResult = ToolResult>(
    name: string,
    input?: JsonObject,
  ) => Promise<TResult>,
): Promise<MultiExecuteToolResult> {
  const request = parseMultiExecuteRequest(input);
  const results = new Array<ToolInvocationResult>(request.invocations.length);
  const remoteInvocations: ToolInvocationRequest[] = [];
  const remoteIndexes: number[] = [];
  const localInvocations: Array<{
    entry: LocalToolEntry;
    invocation: ToolInvocationRequest;
    index: number;
  }> = [];

  request.invocations.forEach((invocation, index) => {
    const entry = localTools.get(normalizeToolName(invocation.tool_name));
    if (!entry) {
      remoteInvocations.push(invocation);
      remoteIndexes.push(index);
      return;
    }
    localInvocations.push({ entry, invocation, index });
  });

  const localPromise = Promise.all(
    localInvocations.map(async ({ entry, invocation, index }) => ({
      index,
      result: await executeLocalInvocation(entry.tool, invocation, context),
    })),
  );
  const remotePromise =
    remoteInvocations.length > 0
      ? executeRemoteMultiExecute(remoteInvocations, callRemoteTool)
      : Promise.resolve<MultiExecuteToolResult>({ results: [] });

  const [localResults, normalizedRemote] = await Promise.all([
    localPromise,
    remotePromise,
  ]);

  for (const { index, result } of localResults) {
    results[index] = result;
  }
  for (let i = 0; i < remoteIndexes.length; i += 1) {
    const result = normalizedRemote.results[i];
    const index = remoteIndexes[i];
    if (result === undefined || index === undefined) {
      continue;
    }
    results[index] = result;
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

async function routeSearchTools(
  input: JsonObject | undefined,
  localTools: LocalToolEntry[],
  callRemoteTool: <TResult extends ToolResult = ToolResult>(
    name: string,
    input?: JsonObject,
  ) => Promise<TResult>,
): Promise<JsonObject> {
  const request = parseSearchToolsRequest(input);
  let result: ReturnType<typeof normalizeSearchToolsResult>;
  try {
    result = normalizeSearchToolsResult(
      await callRemoteTool(SEARCH_TOOLS_NAME, input),
    );
  } catch {
    result = normalizeSearchToolsResult(undefined);
  }
  const remoteNames = new Set(
    result.tools.map((tool) => normalizeToolName(String(tool.tool_name))),
  );
  const localRanked = localTools
    .filter((entry) => !remoteNames.has(entry.key))
    .map((entry) => localToolToRankedTool(entry.tool, request))
    .sort((a, b) => Number(b.score) - Number(a.score));

  const tools = [...localRanked, ...result.tools]
    .sort((a, b) => Number(b.score) - Number(a.score))
    .slice(0, request.max_results);
  const routed: JsonObject = {
    ...result,
    tools,
    confidence:
      typeof result.confidence === "number"
        ? Math.max(result.confidence, Number(tools[0]?.score ?? 0))
        : Number(tools[0]?.score ?? 0),
  };
  const recommendedTool = tools[0] ?? result.recommended_tool;
  if (recommendedTool) {
    routed.recommended_tool = recommendedTool;
  }
  return routed;
}

async function routeGetToolSchemas(
  input: JsonObject | undefined,
  localTools: LocalToolEntry[],
  callRemoteTool: <TResult extends ToolResult = ToolResult>(
    name: string,
    input?: JsonObject,
  ) => Promise<TResult>,
): Promise<JsonObject> {
  const toolNames = parseToolNames(input);
  const localByName = new Map(
    localTools.map((entry) => [entry.key, entry.tool]),
  );
  const localSchemas = toolNames
    .map((name) => localByName.get(normalizeToolName(name)))
    .filter((tool): tool is LocalMcpTool => tool !== undefined)
    .map(localToolToSchemaInfo);
  const remoteToolNames = toolNames.filter(
    (name) => !localByName.has(normalizeToolName(name)),
  );
  if (remoteToolNames.length === 0) {
    return { tools: localSchemas };
  }
  let remoteResult: { tools: JsonObject[] };
  try {
    remoteResult = normalizeGetToolSchemasResult(
      await callRemoteTool(GET_TOOL_SCHEMAS_NAME, {
        ...input,
        tool_names: remoteToolNames,
      }),
    );
  } catch {
    remoteResult = { tools: [] };
  }
  return {
    ...remoteResult,
    tools: [...remoteResult.tools, ...localSchemas],
  };
}

function parseSearchToolsRequest(input: JsonObject | undefined): {
  use_case: string;
  max_results: number;
  include_schemas: boolean;
} {
  const useCase = input?.use_case;
  if (typeof useCase !== "string" || useCase.trim().length === 0) {
    throw new TypeError("SEARCH_TOOLS input must include use_case");
  }
  const maxResults = input?.max_results;
  const includeSchemas = input?.include_schemas;
  return {
    use_case: useCase,
    max_results:
      typeof maxResults === "number" && Number.isFinite(maxResults)
        ? Math.max(1, Math.floor(maxResults))
        : 10,
    include_schemas: includeSchemas === true,
  };
}

function parseToolNames(input: JsonObject | undefined): string[] {
  const toolNames = input?.tool_names;
  if (!Array.isArray(toolNames)) {
    throw new TypeError("GET_TOOL_SCHEMAS input must include tool_names");
  }
  return toolNames.map((name, index) => {
    if (typeof name !== "string" || name.length === 0) {
      throw new TypeError(
        `GET_TOOL_SCHEMAS tool_names[${index}] must be a string`,
      );
    }
    return name;
  });
}

function normalizeSearchToolsResult(value: ToolResult): {
  tools: JsonObject[];
  recommended_tool?: JsonObject;
  recommended_plan_steps: JsonValue[];
  next_steps: JsonValue[];
  confidence: number;
} {
  const result = unwrapStructuredResult(value);
  if (!isJsonObject(result)) {
    return {
      tools: [],
      recommended_plan_steps: [],
      next_steps: [],
      confidence: 0,
    };
  }
  const normalized: {
    tools: JsonObject[];
    recommended_tool?: JsonObject;
    recommended_plan_steps: JsonValue[];
    next_steps: JsonValue[];
    confidence: number;
  } = {
    ...result,
    tools: Array.isArray(result.tools) ? result.tools.filter(isJsonObject) : [],
    recommended_plan_steps: Array.isArray(result.recommended_plan_steps)
      ? result.recommended_plan_steps
      : [],
    next_steps: Array.isArray(result.next_steps) ? result.next_steps : [],
    confidence: typeof result.confidence === "number" ? result.confidence : 0,
  };
  if (isJsonObject(result.recommended_tool)) {
    normalized.recommended_tool = result.recommended_tool;
  }
  return normalized;
}

function normalizeGetToolSchemasResult(value: ToolResult): {
  tools: JsonObject[];
} {
  const result = unwrapStructuredResult(value);
  if (!isJsonObject(result) || !Array.isArray(result.tools)) {
    return { tools: [] };
  }
  return {
    ...result,
    tools: result.tools.filter(isJsonObject),
  };
}

function unwrapStructuredResult(value: ToolResult): ToolResult {
  if (isJsonObject(value) && "structuredContent" in value) {
    return value.structuredContent;
  }
  if (isJsonObject(value) && "structured_content" in value) {
    return value.structured_content;
  }
  return value;
}

function localToolToRankedTool(
  tool: LocalMcpTool,
  request: {
    use_case: string;
    include_schemas: boolean;
  },
): JsonObject {
  const inputSchemaSummary = summarizeSchema(tool.inputSchema);
  const outputSchema = tool.outputSchema ?? { type: "object" };
  const outputSchemaSummary = summarizeSchema(outputSchema);
  const ranked: JsonObject = {
    tool_name: tool.name,
    toolkit: "local",
    score: scoreLocalTool(request.use_case, tool, inputSchemaSummary),
    reason: `Matches the use case against ${tool.name} from local tools.`,
    description: tool.description,
    input_schema_summary: inputSchemaSummary,
    output_schema_summary: outputSchemaSummary,
  };
  if (request.include_schemas) {
    ranked.input_schema = tool.inputSchema;
    ranked.output_schema = outputSchema;
  }
  return ranked;
}

function localToolToSchemaInfo(tool: LocalMcpTool): JsonObject {
  const outputSchema = tool.outputSchema ?? { type: "object" };
  return {
    tool_name: tool.name,
    toolkit: "local",
    description: tool.description,
    input_schema: tool.inputSchema,
    output_schema: outputSchema,
    input_schema_summary: summarizeSchema(tool.inputSchema),
    output_schema_summary: summarizeSchema(outputSchema),
  };
}

function scoreLocalTool(
  useCase: string,
  tool: LocalMcpTool,
  inputSchemaSummary: string,
): number {
  const tokens = useCase
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length > 1);
  const haystack = [tool.name, tool.description, inputSchemaSummary]
    .join(" ")
    .toLowerCase();
  if (tokens.length === 0) {
    return 0.2;
  }
  const hits = tokens.filter((token) => haystack.includes(token)).length;
  return Math.min(1, hits / tokens.length);
}

function summarizeSchema(schema: JsonObject): string {
  const properties = isJsonObject(schema.properties)
    ? Object.keys(schema.properties).slice(0, 6)
    : [];
  const required = Array.isArray(schema.required)
    ? schema.required.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const fields =
    properties.length > 0
      ? `Fields: ${properties.join(", ")}`
      : "Object schema";
  return required.length > 0
    ? `${fields}. Required: ${required.join(", ")}`
    : fields;
}

async function executeRemoteMultiExecute(
  remoteInvocations: ToolInvocationRequest[],
  callRemoteTool: <TResult extends ToolResult = ToolResult>(
    name: string,
    input?: JsonObject,
  ) => Promise<TResult>,
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
  value: ToolResult,
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
    const error =
      isJsonObject(value) && typeof value.error === "string"
        ? value.error
        : "Remote MULTI_EXECUTE_TOOL returned an invalid result shape";
    return {
      results: [
        {
          tool_name: invocations[0]?.tool_name ?? "",
          success: false,
          error,
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
  value: ToolResult,
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

function typedToolResult<TResult extends ToolResult>(
  value: ToolResult,
): TResult {
  return value as unknown as TResult;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
