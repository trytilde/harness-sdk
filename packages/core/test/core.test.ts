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

  it("adds a dynamic function to an MCP server", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://api.example.test/api/v1/team/team_123/mcp/mcp-server/server_1/function",
        );
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          tool_source_type_id: "tool_source",
          tool_group_source_type_id: "tool_group",
          tool_group_instance_id: "tool_group_instance",
          tool_name: "search",
        });

        return Response.json({
          id: "server_1",
          name: "Server 1",
          team_id: "team_123",
          is_dynamic_tool_discovery: true,
          tools: [{ tool_name: "search" }],
        });
      },
    );

    const client = createClient({
      baseUrl: "https://api.example.test",
      teamId: "team_123",
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      client.mcp.addFunction({
        serverId: "server_1",
        toolSourceTypeId: "tool_source",
        toolGroupSourceTypeId: "tool_group",
        toolGroupInstanceId: "tool_group_instance",
        toolName: "search",
      }),
    ).resolves.toMatchObject({
      id: "server_1",
      tools: [{ tool_name: "search" }],
    });
  });

  it("lists available tool groups with deployment alias", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(
        "https://api.example.test/api/v1/team/team_123/mcp/available-tool-groups?page_size=25&deployment_alias=stable",
      );
      return Response.json({
        items: [{ type_id: "github" }],
        next_page_token: "next",
      });
    });

    const client = createClient({
      baseUrl: "https://api.example.test",
      teamId: "team_123",
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      client.mcp.listAvailableToolGroups({
        pageSize: 25,
        deploymentAlias: "stable",
      }),
    ).resolves.toEqual({
      items: [{ type_id: "github" }],
      nextPageToken: "next",
    });
  });
});

describe("AI gateway client", () => {
  it("creates an AI gateway profile through the team-scoped API", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://api.example.test/api/v1/team/team_123/ai-gateway/profile",
        );
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          id: "openai-prod",
          provider_id: "openai",
          resource_server_credential_id: "cred_123",
          kind: "chat",
          model: "gpt-5-mini",
          custom_headers: {},
        });

        return Response.json({
          id: "openai-prod",
          provider_id: "openai",
          base_url: "https://api.openai.com/v1",
          resource_server_credential_id: "cred_123",
          kind: "chat",
          model: "gpt-5-mini",
          org_id: "org_123",
          team_id: "team_123",
          custom_headers: {},
        });
      },
    );

    const client = createClient({
      baseUrl: "https://api.example.test",
      teamId: "team_123",
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      client.aiGateway.createProfile({
        id: "openai-prod",
        providerId: "openai",
        resourceServerCredentialId: "cred_123",
        kind: "chat",
        model: "gpt-5-mini",
      }),
    ).resolves.toMatchObject({
      id: "openai-prod",
      providerId: "openai",
      model: "gpt-5-mini",
    });
  });

  it("constructs OpenAI-compatible gateway base URLs", () => {
    const client = createClient({
      baseUrl: "https://api.example.test/",
      teamId: "team 123",
    });

    expect(
      client.aiGateway.openAiCompatibleBaseUrl({ profileId: "openai/prod" }),
    ).toBe(
      "https://api.example.test/api/v1/team/team%20123/credential-proxy/openai%2Fprod/",
    );
  });
});

describe("ChatKit client", () => {
  it("constructs provider-mounted Vercel UI endpoints", () => {
    const client = createClient({
      baseUrl: "https://api.example.test",
      teamId: "team 123",
    });

    expect(
      client.chatkit.vercelUiEndpoint({
        sessionId: "session/1",
        inboxId: "inbox 1",
        instanceId: "instance:1",
        stream: true,
      }),
    ).toBe(
      "https://api.example.test/api/v1/team/team%20123/inbox/session/session%2F1/inbox/inbox%201/instance/instance%3A1/ai/ui/stream",
    );
  });
});
