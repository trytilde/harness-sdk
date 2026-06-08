import { describe, expect, it, vi } from "vitest";
import { ApiError, createClient, createConfig } from "../src";

describe("createConfig", () => {
  it("normalizes trailing slashes", () => {
    const config = createConfig({
      baseUrl: "https://api.example.test///",
      teamId: "team_123",
    });

    expect(config.baseUrl).toBe("https://api.example.test");
  });

  it("rejects relative baseUrl", () => {
    expect(() =>
      createConfig({
        baseUrl: "/api",
        teamId: "team_123",
      }),
    ).toThrow("baseUrl must be an absolute URL");
  });
});

describe("MCP client", () => {
  it("constructs encoded MCP server URLs", () => {
    const client = createClient({
      baseUrl: "https://api.example.test",
      teamId: "team 123",
    });

    expect(client.mcp.getServerUrl({ id: "server/1" })).toBe(
      "https://api.example.test/api/v1/team/team%20123/mcp/mcp-server/server%2F1/mcp",
    );
  });

  it("sends createServer request with auth headers", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://api.example.test/api/v1/team/team_123/mcp/mcp-server",
        );
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer test-key",
        );
        expect(JSON.parse(String(init?.body))).toEqual({
          id: "server_1",
          name: "Server 1",
          is_dynamic_tool_discovery: true,
        });

        return Response.json({
          id: "server_1",
          name: "Server 1",
          team_id: "team_123",
          org_id: "org_123",
          is_dynamic_tool_discovery: true,
          tools: [],
        });
      },
    );

    const client = createClient({
      baseUrl: "https://api.example.test",
      teamId: "team_123",
      apiKey: "test-key",
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      client.mcp.createServer({
        id: "server_1",
        name: "Server 1",
        isDynamicToolDiscovery: true,
      }),
    ).resolves.toMatchObject({
      id: "server_1",
      url: "https://api.example.test/api/v1/team/team_123/mcp/mcp-server/server_1/mcp",
    });
  });

  it("throws ApiError for non-2xx responses", async () => {
    const client = createClient({
      baseUrl: "https://api.example.test",
      teamId: "team_123",
      fetch: (async () =>
        Response.json({ msg: "nope" }, { status: 403 })) as typeof fetch,
    });

    await expect(
      client.mcp.getServer({ id: "missing" }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
