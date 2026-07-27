import { createClient } from "@tilde/harness-sdk";
import type { ToolExecutionOptions } from "ai";
import { jsonSchema, tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createMCPClient } from "../src";

const mocks = vi.hoisted(() => {
  const remoteClient = {
    serverInfo: { name: "remote", version: "1.0.0" },
    tools: vi.fn(async () => ({
      REMOTE_SEARCH: { description: "Remote search" },
    })),
    callTool: vi.fn(async (name: string, input?: Record<string, unknown>) => ({
      name,
      input,
    })),
    close: vi.fn(async () => undefined),
  };

  return {
    remoteClient,
    createVercelMCPClient: vi.fn(async (_config: unknown) => remoteClient),
  };
});

vi.mock("@ai-sdk/mcp", () => ({
  createMCPClient: mocks.createVercelMCPClient,
}));

describe("createMCPClient", () => {
  it("creates a Vercel AI SDK MCP client using x-api-key auth", async () => {
    const client = createClient({
      baseUrl: "https://api.example.test",
      teamId: "team 123",
      apiKey: "tilde-key",
    });

    await createMCPClient({
      client,
      serverId: "server/1",
      headers: {
        "x-extra": "value",
      },
    });

    expect(mocks.createVercelMCPClient).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: {
          type: "http",
          url: "https://api.example.test/api/v1/team/team%20123/mcp/mcp-server/server%2F1/mcp",
          headers: {
            "x-extra": "value",
            "x-api-key": "tilde-key",
          },
          fetch: undefined,
        },
      }),
    );
    const config = mocks.createVercelMCPClient.mock.calls.at(-1)?.[0] as
      | { transport: { headers: Record<string, string> } }
      | undefined;
    expect(config?.transport).not.toMatchObject({
      headers: expect.objectContaining({
        Authorization: expect.any(String),
      }),
    });
  });

  it("forwards org context for a non-subdomain tunnel", async () => {
    const client = createClient({
      baseUrl: "https://example.ngrok-free.app",
      orgId: "org-example",
      orgSubdomain: false,
      teamId: "team_123",
      apiKey: "tilde-key",
    });

    await createMCPClient({
      client,
      serverId: "server_1",
    });

    const config = mocks.createVercelMCPClient.mock.calls.at(-1)?.[0] as
      | { transport: { headers: Record<string, string>; url: string } }
      | undefined;
    expect(config?.transport.url).toBe(
      "https://example.ngrok-free.app/api/v1/team/team_123/mcp/mcp-server/server_1/mcp",
    );
    expect(config?.transport.headers).toMatchObject({
      "x-api-key": "tilde-key",
      "x-tilde-org-id": "org-example",
    });
  });

  it("registers provided AI SDK tools as local MCP tools", async () => {
    const client = createClient({
      baseUrl: "https://api.example.test",
      teamId: "team_123",
      apiKey: "tilde-key",
    });
    const execute = vi.fn(async (input: { value?: string }) => ({
      echoed: input.value,
    }));
    const example = tool({
      description: "Echo input",
      inputSchema: jsonSchema<{ value?: string }>({
        type: "object",
        properties: {
          value: { type: "string" },
        },
      }),
      execute,
    });

    const mcp = await createMCPClient({
      client,
      serverId: "server_1",
      tools: {
        example,
      },
    });

    await expect(mcp.callTool("example", { value: "hello" })).resolves.toEqual({
      echoed: "hello",
    });
    await expect(mcp.callTool("example", { value: "again" })).resolves.toEqual({
      echoed: "again",
    });
    const calls = execute.mock.calls as unknown as Array<
      [input: { value?: string }, options: ToolExecutionOptions]
    >;
    const firstOptions = calls[0]?.[1];
    const secondOptions = calls[1]?.[1];
    expect(firstOptions?.toolCallId).toMatch(/^example-/);
    expect(secondOptions?.toolCallId).toMatch(/^example-/);
    expect(firstOptions?.toolCallId).not.toBe(secondOptions?.toolCallId);
    await expect(mcp.tools()).resolves.toMatchObject({
      REMOTE_SEARCH: { description: "Remote search" },
      example: { description: "Echo input" },
    });
  });

  it("requires an apiKey on the core client", async () => {
    const client = createClient({
      baseUrl: "https://api.example.test",
      teamId: "team_123",
      bearerToken: "tilde-bearer",
    });

    await expect(
      createMCPClient({
        client,
        serverId: "server_1",
      }),
    ).rejects.toThrow("apiKey");
  });
});
