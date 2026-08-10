import { z } from "zod";
import {
  type VerifyWebhookOptions,
  verifyWebhookSignature,
  WebhookVerificationError,
} from "./webhook";

type AnyZodObject = z.ZodObject;

type ToolEndpointToolShape = {
  id: string;
  name: string;
  description: string;
  inputSchema: AnyZodObject;
  outputSchema: AnyZodObject;
  fn: unknown;
};

export type ToolEndpointTool<
  TInputSchema extends AnyZodObject = AnyZodObject,
  TOutputSchema extends AnyZodObject = AnyZodObject,
> = {
  id: string;
  name: string;
  description: string;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  fn(
    input: z.output<TInputSchema>,
    request: Request,
  ): Promise<z.output<TOutputSchema>>;
};

export type ToolEndpointProvider = {
  name: string;
  description?: string;
  version?: string;
};

type ToolEndpointBaseOptions = VerifyWebhookOptions & {
  provider: ToolEndpointProvider;
  /** Public origin override, for example https://agents.example.com. */
  baseUrl?: string;
  /** Public pathname override, for example /api/tools. */
  endpointPath?: string;
};

export type ToolEndpointOptions<
  TTools extends readonly ToolEndpointTool[] = readonly ToolEndpointTool[],
> = ToolEndpointBaseOptions & { tools: TTools };

export type ToolEndpoint = {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
};

type RuntimeTool = Omit<ToolEndpointToolShape, "fn"> & {
  fn(input: Record<string, unknown>, request: Request): Promise<unknown>;
};

type ToolInvocation = {
  tool_source_type_id: string;
  params: unknown;
};

export function toolEndpoint<I1 extends AnyZodObject, O1 extends AnyZodObject>(
  options: ToolEndpointOptions<readonly [ToolEndpointTool<I1, O1>]>,
): ToolEndpoint;
export function toolEndpoint<
  I1 extends AnyZodObject,
  O1 extends AnyZodObject,
  I2 extends AnyZodObject,
  O2 extends AnyZodObject,
>(
  options: ToolEndpointOptions<
    readonly [ToolEndpointTool<I1, O1>, ToolEndpointTool<I2, O2>]
  >,
): ToolEndpoint;
export function toolEndpoint<
  I1 extends AnyZodObject,
  O1 extends AnyZodObject,
  I2 extends AnyZodObject,
  O2 extends AnyZodObject,
  I3 extends AnyZodObject,
  O3 extends AnyZodObject,
>(
  options: ToolEndpointOptions<
    readonly [
      ToolEndpointTool<I1, O1>,
      ToolEndpointTool<I2, O2>,
      ToolEndpointTool<I3, O3>,
    ]
  >,
): ToolEndpoint;
export function toolEndpoint<
  I1 extends AnyZodObject,
  O1 extends AnyZodObject,
  I2 extends AnyZodObject,
  O2 extends AnyZodObject,
  I3 extends AnyZodObject,
  O3 extends AnyZodObject,
  I4 extends AnyZodObject,
  O4 extends AnyZodObject,
>(
  options: ToolEndpointOptions<
    readonly [
      ToolEndpointTool<I1, O1>,
      ToolEndpointTool<I2, O2>,
      ToolEndpointTool<I3, O3>,
      ToolEndpointTool<I4, O4>,
    ]
  >,
): ToolEndpoint;
export function toolEndpoint(options: ToolEndpointOptions): ToolEndpoint;
export function toolEndpoint(
  options: ToolEndpointBaseOptions & {
    tools: readonly ToolEndpointToolShape[];
  },
): ToolEndpoint {
  validateOptions(options);
  const tools = options.tools as unknown as readonly RuntimeTool[];
  const toolsById = new Map(tools.map((tool) => [tool.id, tool]));
  const manifestTools = tools.map((tool) => ({
    type_id: tool.id,
    name: tool.name,
    description: tool.description,
    input_schema: z.toJSONSchema(tool.inputSchema, { target: "draft-07" }),
    output_schema: z.toJSONSchema(tool.outputSchema, { target: "draft-07" }),
  }));
  const configuredBaseUrl = options.baseUrl
    ? validatedBaseUrl(options.baseUrl)
    : undefined;

  return {
    async GET(request) {
      const verificationError = await verifyRequest(request, options);
      if (verificationError) return verificationError;

      return Response.json({
        provider: options.provider,
        invoke_url: resolveEndpointUrl(
          request,
          configuredBaseUrl,
          options.endpointPath,
        ),
        tools: manifestTools,
      });
    },

    async POST(request) {
      const executionRequest = request.clone();
      const verification = await verifiedRequest(request, options);
      if (verification instanceof Response) return verification;

      let invocation: ToolInvocation;
      try {
        invocation = parseInvocation(verification.rawBody);
      } catch (error) {
        return errorResponse(errorMessage(error), 400);
      }

      const tool = toolsById.get(invocation.tool_source_type_id);
      if (!tool) {
        return invokeError(`Unknown tool: ${invocation.tool_source_type_id}`);
      }

      const input = await tool.inputSchema.safeParseAsync(invocation.params);
      if (!input.success) {
        return invokeError(
          `Invalid ${tool.id} input: ${z.prettifyError(input.error)}`,
        );
      }

      let output: unknown;
      try {
        output = await tool.fn(input.data, executionRequest);
      } catch (error) {
        return invokeError(errorMessage(error));
      }

      const parsedOutput = await tool.outputSchema.safeParseAsync(output);
      if (!parsedOutput.success) {
        return invokeError(
          `Invalid ${tool.id} output: ${z.prettifyError(parsedOutput.error)}`,
        );
      }

      return Response.json({ ...parsedOutput.data, type: "success" });
    },
  };
}

function validateOptions(
  options: ToolEndpointBaseOptions & {
    tools: readonly ToolEndpointToolShape[];
  },
): void {
  if (!options.provider.name.trim()) {
    throw new TypeError("toolEndpoint requires provider.name");
  }
  if (!options.webhookSigningKey) {
    throw new TypeError("toolEndpoint requires webhookSigningKey");
  }
  if (options.tools.length === 0) {
    throw new TypeError("toolEndpoint requires at least one tool");
  }
  if (
    options.endpointPath !== undefined &&
    !options.endpointPath.startsWith("/")
  ) {
    throw new TypeError("toolEndpoint endpointPath must start with /");
  }

  const ids = new Set<string>();
  for (const tool of options.tools) {
    if (!tool.id.trim())
      throw new TypeError("toolEndpoint tool id is required");
    if (ids.has(tool.id)) {
      throw new TypeError(`toolEndpoint tool id must be unique: ${tool.id}`);
    }
    ids.add(tool.id);
    if (!tool.name.trim()) {
      throw new TypeError(`toolEndpoint tool name is required: ${tool.id}`);
    }
    if (!tool.description.trim()) {
      throw new TypeError(
        `toolEndpoint tool description is required: ${tool.id}`,
      );
    }
    if (!(tool.inputSchema instanceof z.ZodObject)) {
      throw new TypeError(
        `toolEndpoint inputSchema must be a Zod object: ${tool.id}`,
      );
    }
    if (!(tool.outputSchema instanceof z.ZodObject)) {
      throw new TypeError(
        `toolEndpoint outputSchema must be a Zod object: ${tool.id}`,
      );
    }
    if (typeof (tool as { fn?: unknown }).fn !== "function") {
      throw new TypeError(`toolEndpoint fn is required: ${tool.id}`);
    }
  }
}

function validatedBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("toolEndpoint baseUrl must be an absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("toolEndpoint baseUrl must use http or https");
  }
  return url;
}

function resolveEndpointUrl(
  request: Request,
  configuredBaseUrl: URL | undefined,
  endpointPath: string | undefined,
): string {
  const requestUrl = new URL(request.url);
  const baseUrl = configuredBaseUrl ?? requestUrl;
  const url = new URL(endpointPath ?? requestUrl.pathname, baseUrl.origin);
  return url.toString();
}

async function verifyRequest(
  request: Request,
  options: VerifyWebhookOptions,
): Promise<Response | undefined> {
  const result = await verifiedRequest(request, options);
  return result instanceof Response ? result : undefined;
}

async function verifiedRequest(
  request: Request,
  options: VerifyWebhookOptions,
) {
  try {
    return await verifyWebhookSignature(request, options);
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      return errorResponse(error.message, 401);
    }
    throw error;
  }
}

function parseInvocation(rawBody: Uint8Array): ToolInvocation {
  const parsed = JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
  if (!isRecord(parsed) || typeof parsed.tool_source_type_id !== "string") {
    throw new TypeError("Invalid tool invocation body");
  }
  return {
    tool_source_type_id: parsed.tool_source_type_id,
    params: parsed.params,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invokeError(message: string): Response {
  return Response.json({ type: "error", message });
}

function errorResponse(message: string, status: number): Response {
  return Response.json({ type: "error", message }, { status });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Tool execution failed";
}
