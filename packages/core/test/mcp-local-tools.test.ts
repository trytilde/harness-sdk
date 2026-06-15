import { describe, expect, it, vi } from "vitest";
import {
  createClient,
  GET_TOOL_SCHEMAS_NAME,
  type LocalMcpTool,
  MULTI_EXECUTE_TOOL_NAME,
  REGISTER_LOCAL_TOOLS_METHOD,
  SEARCH_TOOLS_NAME,
  wrapMcpClientWithLocalTools,
} from "../src";

const localEchoTool = (name = "LOCAL_ECHO"): LocalMcpTool => ({
  name,
  description: "Echo local input.",
  inputSchema: {
    type: "object",
    properties: {
      value: { type: "string" },
    },
  },
  async execute(input) {
    return { echoed: input.value };
  },
});

describe("local MCP tools wrapper", () => {
  it("adds local tools to tools() results", async () => {
    const remoteClient = {
      tools: vi.fn(async () => ({
        REMOTE_SEARCH: { description: "Remote search" },
      })),
    };

    const wrapped = wrapMcpClientWithLocalTools({
      client: remoteClient,
      serverId: "server_1",
      tools: [localEchoTool()],
    });

    const tools: Record<string, unknown> = await wrapped.tools();

    expect(Object.keys(tools)).toEqual(["REMOTE_SEARCH", "LOCAL_ECHO"]);
    expect(tools.LOCAL_ECHO).toMatchObject({
      description: "Echo local input.",
      inputSchema: localEchoTool().inputSchema,
      parameters: localEchoTool().inputSchema,
    });
    expect(remoteClient.tools).toHaveBeenCalledOnce();
  });

  it("rejects duplicate local tool names", () => {
    expect(() =>
      wrapMcpClientWithLocalTools({
        client: {},
        serverId: "server_1",
        tools: [localEchoTool("LOCAL_ECHO"), localEchoTool("local_echo")],
      }),
    ).toThrow("Duplicate local MCP tool name");
  });

  it("rejects collisions with remote tool names", async () => {
    const wrapped = wrapMcpClientWithLocalTools({
      client: {
        tools: async () => ({
          local_echo: {},
        }),
      },
      serverId: "server_1",
      tools: [localEchoTool()],
    });

    await expect(wrapped.tools()).rejects.toThrow(
      "collides with remote MCP tool",
    );
  });

  it("rejects reserved local tool names", () => {
    expect(() =>
      wrapMcpClientWithLocalTools({
        client: {},
        serverId: "server_1",
        tools: [localEchoTool(MULTI_EXECUTE_TOOL_NAME)],
      }),
    ).toThrow("reserved");
  });

  it("executes direct local tool calls in-process", async () => {
    const execute = vi.fn(async (input: Record<string, unknown>) => ({
      local: input.value,
    }));
    const wrapped = wrapMcpClientWithLocalTools({
      client: {
        callTool: vi.fn(),
      },
      serverId: "server_1",
      tools: [
        {
          ...localEchoTool(),
          execute,
        },
      ],
    });

    await expect(
      wrapped.callTool("LOCAL_ECHO", { value: "hello" }),
    ).resolves.toEqual({ local: "hello" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("registers local tool schemas with the remote MCP session", async () => {
    const request = vi.fn(async () => ({ registered: ["LOCAL_ECHO"] }));
    const wrapped = wrapMcpClientWithLocalTools({
      client: {
        request,
        tools: async () => ({}),
      },
      serverId: "server_1",
      tools: [localEchoTool()],
      registerWithServer: true,
    });

    await wrapped.tools();

    expect(request).toHaveBeenCalledWith({
      method: REGISTER_LOCAL_TOOLS_METHOD,
      params: {
        tools: [
          {
            name: "LOCAL_ECHO",
            description: "Echo local input.",
            input_schema: localEchoTool().inputSchema,
          },
        ],
      },
    });
  });

  it("merges local tools into SEARCH_TOOLS results", async () => {
    const callTool = vi.fn(async (name: string) => {
      expect(name).toBe(SEARCH_TOOLS_NAME);
      return {
        tools: [
          {
            tool_name: "REMOTE_SEARCH",
            toolkit: "remote",
            score: 0.1,
            reason: "remote",
            description: "Remote search.",
            input_schema_summary: "Fields: query",
            output_schema_summary: "Object schema",
          },
        ],
        recommended_plan_steps: [],
        next_steps: [],
        confidence: 0.1,
      };
    });
    const wrapped = wrapMcpClientWithLocalTools({
      client: { callTool },
      serverId: "server_1",
      tools: [localEchoTool()],
    });

    const result = await wrapped.callTool(SEARCH_TOOLS_NAME, {
      use_case: "echo local value",
      include_schemas: true,
    });

    expect(result).toMatchObject({
      recommended_tool: {
        tool_name: "LOCAL_ECHO",
        toolkit: "local",
      },
      tools: [
        {
          tool_name: "LOCAL_ECHO",
          toolkit: "local",
          input_schema: localEchoTool().inputSchema,
        },
        {
          tool_name: "REMOTE_SEARCH",
        },
      ],
    });
  });

  it("merges local schemas into GET_TOOL_SCHEMAS results", async () => {
    const callTool = vi.fn(async (name: string, input?: Record<string, unknown>) => {
      expect(name).toBe(GET_TOOL_SCHEMAS_NAME);
      expect(input).toMatchObject({ tool_names: ["REMOTE_SEARCH"] });
      return {
        tools: [
          {
            tool_name: "REMOTE_SEARCH",
            toolkit: "remote",
            description: "Remote search.",
            input_schema: { type: "object" },
            output_schema: { type: "object" },
            input_schema_summary: "Object schema",
            output_schema_summary: "Object schema",
          },
        ],
      };
    });
    const wrapped = wrapMcpClientWithLocalTools({
      client: { callTool },
      serverId: "server_1",
      tools: [localEchoTool()],
    });

    await expect(
      wrapped.callTool(GET_TOOL_SCHEMAS_NAME, {
        tool_names: ["LOCAL_ECHO", "REMOTE_SEARCH"],
      }),
    ).resolves.toMatchObject({
      tools: [
        { tool_name: "REMOTE_SEARCH" },
        {
          tool_name: "LOCAL_ECHO",
          toolkit: "local",
          input_schema: localEchoTool().inputSchema,
        },
      ],
    });
  });

  it("forwards direct remote tool calls", async () => {
    const callTool = vi.fn(
      async (name: string, input?: Record<string, unknown>) => ({
        name,
        input,
      }),
    );
    const wrapped = wrapMcpClientWithLocalTools({
      client: { callTool },
      serverId: "server_1",
      tools: [localEchoTool()],
    });

    await expect(
      wrapped.callTool("REMOTE_SEARCH", { query: "x" }),
    ).resolves.toEqual({
      name: "REMOTE_SEARCH",
      input: { query: "x" },
    });
    expect(callTool).toHaveBeenCalledWith("REMOTE_SEARCH", { query: "x" });
  });

  it("provides local and remote context helpers", async () => {
    const callTool = vi.fn(async (name: string) => ({ remote: name }));
    const getContext = vi.fn(async (_input, context) => ({
      sibling: await context.callLocalTool("LOCAL_SIBLING", { id: "1" }),
      remote: await context.callRemoteTool("REMOTE_GET", { id: "2" }),
    }));
    const wrapped = wrapMcpClientWithLocalTools({
      client: { callTool },
      serverId: "server_1",
      tools: [
        {
          ...localEchoTool("LOCAL_CONTEXT"),
          execute: getContext,
        },
        {
          ...localEchoTool("LOCAL_SIBLING"),
          async execute(input) {
            return { sibling: input.id };
          },
        },
      ],
    });

    await expect(wrapped.callTool("LOCAL_CONTEXT", {})).resolves.toEqual({
      sibling: { sibling: "1" },
      remote: { remote: "REMOTE_GET" },
    });
    expect(callTool).toHaveBeenCalledWith("REMOTE_GET", { id: "2" });
  });

  it("splits mixed MULTI_EXECUTE_TOOL calls and preserves order", async () => {
    const callTool = vi.fn(
      async (name: string, input?: Record<string, unknown>) => {
        expect(name).toBe(MULTI_EXECUTE_TOOL_NAME);
        expect(input).toEqual({
          invocations: [
            { tool_name: "REMOTE_ONE", parameters: { q: "remote" } },
            { tool_name: "REMOTE_TWO" },
          ],
        });
        return {
          results: [
            {
              tool_name: "REMOTE_ONE",
              success: true,
              output: { remote: 1 },
            },
            {
              tool_name: "REMOTE_TWO",
              success: false,
              error: "remote failed",
            },
          ],
        };
      },
    );
    const wrapped = wrapMcpClientWithLocalTools({
      client: { callTool },
      serverId: "server_1",
      tools: [localEchoTool()],
    });

    await expect(
      wrapped.callTool(MULTI_EXECUTE_TOOL_NAME, {
        invocations: [
          { tool_name: "LOCAL_ECHO", parameters: { value: "local" } },
          { tool_name: "REMOTE_ONE", parameters: { q: "remote" } },
          { tool_name: "REMOTE_TWO" },
        ],
      }),
    ).resolves.toEqual({
      results: [
        {
          tool_name: "LOCAL_ECHO",
          success: true,
          output: { echoed: "local" },
        },
        {
          tool_name: "REMOTE_ONE",
          success: true,
          output: { remote: 1 },
        },
        {
          tool_name: "REMOTE_TWO",
          success: false,
          error: "remote failed",
        },
      ],
    });
  });

  it("executes local and remote MULTI_EXECUTE_TOOL branches in parallel", async () => {
    let releaseLocal: () => void = () => undefined;
    const localStarted = vi.fn();
    const callTool = vi.fn(async () => ({
      results: [
        {
          tool_name: "REMOTE_ONE",
          success: true,
          output: { remote: true },
        },
      ],
    }));
    const wrapped = wrapMcpClientWithLocalTools({
      client: { callTool },
      serverId: "server_1",
      tools: [
        {
          ...localEchoTool(),
          async execute() {
            localStarted();
            await new Promise<void>((resolve) => {
              releaseLocal = resolve;
            });
            return { local: true };
          },
        },
      ],
    });

    const resultPromise = wrapped.callTool(MULTI_EXECUTE_TOOL_NAME, {
      invocations: [
        { tool_name: "LOCAL_ECHO" },
        { tool_name: "REMOTE_ONE" },
      ],
    });
    await expect.poll(() => localStarted.mock.calls.length).toBe(1);
    await expect.poll(() => callTool.mock.calls.length).toBe(1);
    releaseLocal();

    await expect(resultPromise).resolves.toEqual({
      results: [
        {
          tool_name: "LOCAL_ECHO",
          success: true,
          output: { local: true },
        },
        {
          tool_name: "REMOTE_ONE",
          success: true,
          output: { remote: true },
        },
      ],
    });
  });

  it("returns per-tool errors for local failures in MULTI_EXECUTE_TOOL", async () => {
    const wrapped = wrapMcpClientWithLocalTools({
      client: {},
      serverId: "server_1",
      tools: [
        {
          ...localEchoTool(),
          async execute() {
            throw new Error("local failed");
          },
        },
      ],
    });

    await expect(
      wrapped.callTool(MULTI_EXECUTE_TOOL_NAME, {
        invocations: [{ tool_name: "LOCAL_ECHO" }],
      }),
    ).resolves.toEqual({
      results: [
        {
          tool_name: "LOCAL_ECHO",
          success: false,
          error: "local failed",
        },
      ],
    });
  });

  it("returns per-tool errors for remote MULTI_EXECUTE_TOOL failures", async () => {
    const wrapped = wrapMcpClientWithLocalTools({
      client: {
        async callTool() {
          throw new Error("remote unavailable");
        },
      },
      serverId: "server_1",
      tools: [localEchoTool()],
    });

    await expect(
      wrapped.callTool(MULTI_EXECUTE_TOOL_NAME, {
        invocations: [
          { tool_name: "LOCAL_ECHO", parameters: { value: "local" } },
          { tool_name: "REMOTE_ONE" },
        ],
      }),
    ).resolves.toEqual({
      results: [
        {
          tool_name: "LOCAL_ECHO",
          success: true,
          output: { echoed: "local" },
        },
        {
          tool_name: "REMOTE_ONE",
          success: false,
          error: "remote unavailable",
        },
      ],
    });
  });

  it("forwards close to the wrapped client", async () => {
    const close = vi.fn();
    const wrapped = wrapMcpClientWithLocalTools({
      client: { close },
      serverId: "server_1",
      tools: [],
    });

    await wrapped.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("is available through McpClient.withLocalTools", async () => {
    const client = createClient({
      baseUrl: "https://api.example.test",
      teamId: "team_123",
    });
    const wrapped = client.mcp.withLocalTools({
      client: {},
      serverId: "server_1",
      tools: [localEchoTool()],
    });

    await expect(
      wrapped.callTool("LOCAL_ECHO", { value: "x" }),
    ).resolves.toEqual({
      echoed: "x",
    });
  });
});
