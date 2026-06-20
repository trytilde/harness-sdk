import { describe, expect, it, vi } from "vitest";
import { ApiError, createClient, createConfig } from "../src";

const spawnMock = vi.fn(() => ({
  killed: false,
  kill: vi.fn(),
  once: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

describe("createConfig", () => {
  it("normalizes trailing slashes", () => {
    const config = createConfig({
      baseUrl: "https://api.example.test///",
      teamId: "team_123",
    });

    expect(config.baseUrl).toBe("https://api.example.test");
  });

  it("derives baseUrl from orgId", () => {
    const config = createConfig({
      orgId: "org-example",
      teamId: "team_123",
    });

    expect(config.baseUrl).toBe("https://org-example.api.trytilde.com");
  });

  it("derives org baseUrl from configured baseApiUrl", () => {
    const config = createConfig({
      baseApiUrl: "https://api.staging.trytilde.com",
      orgId: "org-example",
      teamId: "team_123",
    });

    expect(config.baseUrl).toBe("https://org-example.api.staging.trytilde.com");
  });

  it("rejects orgId values that cannot be used as a hostname label", () => {
    const invalidOrgIds = [
      "org example",
      "org/example",
      "-org-example",
      "org-example-",
      "org.example",
    ];

    for (const orgId of invalidOrgIds) {
      expect(() =>
        createConfig({
          orgId,
          teamId: "team_123",
        }),
      ).toThrow(
        "orgId must be a valid hostname label using letters, numbers, or hyphens",
      );
    }
  });

  it("derives org baseUrl from TILDE_BASE_API_URL", () => {
    const previous = process.env.TILDE_BASE_API_URL;
    process.env.TILDE_BASE_API_URL = "https://api.env.trytilde.com";
    try {
      const config = createConfig({
        orgId: "org-example",
        teamId: "team_123",
      });

      expect(config.baseUrl).toBe("https://org-example.api.env.trytilde.com");
    } finally {
      if (previous === undefined) {
        delete process.env.TILDE_BASE_API_URL;
      } else {
        process.env.TILDE_BASE_API_URL = previous;
      }
    }
  });

  it("rejects relative baseUrl", () => {
    expect(() =>
      createConfig({
        baseUrl: "/api",
        teamId: "team_123",
      }),
    ).toThrow("baseUrl must be an absolute URL");
  });

  it("preserves tunnel and cloudflaredPath", () => {
    const config = createConfig({
      baseUrl: "https://api.example.test",
      teamId: "team_123",
      tunnel: true,
      cloudflaredPath: "/usr/local/bin/cloudflared",
    });

    expect(config.tunnel).toBe(true);
    expect(config.cloudflaredPath).toBe("/usr/local/bin/cloudflared");
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

  it("starts cloudflared when tunnel is enabled", async () => {
    spawnMock.mockClear();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://api.example.test/api/v1/identity/local-runtime/tunnel-connector",
        );
        expect(init?.method).toBe("GET");
        expect(new Headers(init?.headers).get("x-api-key")).toBe("tunnel-key");
        return Response.json({
          tunnel_domain: "user-abc.tunnel.trytilde-dev.com",
          tunnel_origin: "https://user-abc.tunnel.trytilde-dev.com",
          cloudflared_token: "cloudflare-token",
        });
      },
    );

    const client = createClient({
      baseUrl: "https://api.example.test",
      teamId: "team_123",
      apiKey: "tunnel-key",
      tunnel: true,
      cloudflaredPath: "cloudflared-test",
      fetch: fetchMock as typeof fetch,
    });

    const tunnel = await client.localRuntimeTunnel;

    expect(tunnel?.connector.tunnel_origin).toBe(
      "https://user-abc.tunnel.trytilde-dev.com",
    );
    expect(spawnMock).toHaveBeenCalledWith(
      "cloudflared-test",
      ["tunnel", "run", "--token", "cloudflare-token"],
      { stdio: "inherit" },
    );
  });

  it("observes tunnel startup rejections when callers do not await the tunnel promise", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () =>
      Response.json({ message: "bad key" }, { status: 401 }),
    );

    try {
      const client = createClient({
        baseUrl: "https://api.example.test",
        teamId: "team_123",
        apiKey: "bad-key",
        tunnel: true,
        fetch: fetchMock as typeof fetch,
      });

      await expect(client.localRuntimeTunnel).rejects.toBeInstanceOf(ApiError);
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to start local runtime tunnel",
        expect.any(ApiError),
      );
    } finally {
      consoleError.mockRestore();
    }
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

  it("does not inject bearer auth when x-api-key is explicit", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("x-api-key")).toBe("test-key");
        expect(headers.has("Authorization")).toBe(false);

        return Response.json({
          id: "server_1",
          name: "Server 1",
          team_id: "team_123",
          is_dynamic_tool_discovery: false,
          tools: [],
        });
      },
    );

    const client = createClient({
      baseUrl: "https://api.example.test",
      teamId: "team_123",
      apiKey: "test-key",
      headers: {
        "x-api-key": "test-key",
      },
      fetch: fetchMock as typeof fetch,
    });

    await client.mcp.createServer({
      id: "server_1",
      name: "Server 1",
    });
  });

  it("throws ApiError for non-2xx responses", async () => {
    const client = createClient({
      baseUrl: "https://api.example.test",
      teamId: "team_123",
      fetch: (async () =>
        Response.json({ msg: "nope" }, { status: 403 })) as typeof fetch,
    });

    try {
      await client.mcp.getServer({ id: "missing" });
      throw new Error("Expected request to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        name: "ApiError",
        message: "nope",
        status: 403,
        body: { msg: "nope" },
      });
    }
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

  it("updates an MCP server", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://api.example.test/api/v1/team/team_123/mcp/mcp-server/server_1",
        );
        expect(init?.method).toBe("PATCH");
        expect(JSON.parse(String(init?.body))).toEqual({
          name: "Server 1 updated",
          is_dynamic_tool_discovery: false,
        });

        return Response.json({
          id: "server_1",
          name: "Server 1 updated",
          team_id: "team_123",
          is_dynamic_tool_discovery: false,
          tools: [],
        });
      },
    );

    const client = createClient({
      baseUrl: "https://api.example.test",
      teamId: "team_123",
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      client.mcp.updateServer({
        id: "server_1",
        name: "Server 1 updated",
        isDynamicToolDiscovery: false,
      }),
    ).resolves.toMatchObject({
      id: "server_1",
      isDynamicToolDiscovery: false,
    });
  });

  it("enables a tool on an MCP tool group", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://api.example.test/api/v1/team/team_123/mcp/tool-group/tool_group_instance/tool/tool_source/enable",
        );
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          bound_params: { workspace: "sdk" },
        });

        return Response.json({
          tool_source_type_id: "tool_source",
          tool_group_instance_id: "tool_group_instance",
        });
      },
    );

    const client = createClient({
      baseUrl: "https://api.example.test",
      teamId: "team_123",
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      client.mcp.enableTool({
        toolGroupInstanceId: "tool_group_instance",
        toolSourceTypeId: "tool_source",
        boundParams: { workspace: "sdk" },
      }),
    ).resolves.toMatchObject({
      tool_source_type_id: "tool_source",
      tool_group_instance_id: "tool_group_instance",
    });
  });

  it("deletes MCP server and tool group fixtures", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => {
      return new Response(null, { status: 204 });
    });

    const client = createClient({
      baseUrl: "https://api.example.test",
      teamId: "team_123",
      fetch: fetchMock as typeof fetch,
    });

    await client.mcp.deleteServer({ id: "server_1" });
    await client.mcp.deleteToolGroup({ id: "tool_group_1" });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.example.test/api/v1/team/team_123/mcp/mcp-server/server_1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.example.test/api/v1/team/team_123/mcp/tool-group/tool_group_1",
      expect.objectContaining({ method: "DELETE" }),
    );
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
