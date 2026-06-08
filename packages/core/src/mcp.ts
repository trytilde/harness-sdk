import type { Config } from "./config";
import { requestJson } from "./internal/fetch-client";
import { buildUrl, pathWithParams, teamPath } from "./internal/paths";

const MCP_SERVER_PATH = "/api/v1/team/{team_id}/mcp/mcp-server";
const MCP_SERVER_INSTANCE_PATH =
  "/api/v1/team/{team_id}/mcp/mcp-server/{mcp_server_instance_id}";
const MCP_PROTOCOL_PATH =
  "/api/v1/team/{team_id}/mcp/mcp-server/{mcp_server_instance_id}/mcp";

export type CreateMcpServerInput = {
  id: string;
  name: string;
  isDynamicToolDiscovery?: boolean;
};

export type McpServer = {
  id: string;
  name: string;
  teamId: string;
  orgId?: string;
  isDynamicToolDiscovery: boolean;
  url: string;
  tools: unknown[];
};

type RawMcpServer = {
  id: string;
  name: string;
  org_id?: string;
  team_id?: string;
  is_dynamic_tool_discovery?: boolean;
  tools?: unknown[];
};

type Paginated<T> = {
  items: T[];
  next_page_token?: string | null;
};

export class McpClient {
  readonly #config: Config;

  constructor(config: Config) {
    this.#config = config;
  }

  async createServer(input: CreateMcpServerInput): Promise<McpServer> {
    const raw = await requestJson<RawMcpServer>(this.#config, {
      method: "POST",
      path: teamPath(this.#config, MCP_SERVER_PATH),
      body: {
        id: input.id,
        name: input.name,
        is_dynamic_tool_discovery: input.isDynamicToolDiscovery ?? false,
      },
    });
    return this.#toMcpServer(raw);
  }

  async listServers(input?: {
    pageSize?: number;
    nextPageToken?: string;
  }): Promise<{ items: McpServer[]; nextPageToken?: string }> {
    const pageSize = input?.pageSize ?? 100;
    const raw = await requestJson<Paginated<RawMcpServer>>(this.#config, {
      path: teamPath(this.#config, MCP_SERVER_PATH),
      query: {
        page_size: pageSize,
        next_page_token: input?.nextPageToken,
      },
    });
    const result: { items: McpServer[]; nextPageToken?: string } = {
      items: raw.items.map((item) => this.#toMcpServer(item)),
    };
    if (raw.next_page_token) {
      result.nextPageToken = raw.next_page_token;
    }
    return result;
  }

  async getServer(input: { id: string }): Promise<McpServer> {
    const raw = await requestJson<RawMcpServer>(this.#config, {
      path: pathWithParams(teamPath(this.#config, MCP_SERVER_INSTANCE_PATH), {
        mcp_server_instance_id: input.id,
      }),
    });
    return this.#toMcpServer(raw);
  }

  getServerUrl(input: { id: string }): string {
    return buildUrl(
      this.#config,
      pathWithParams(teamPath(this.#config, MCP_PROTOCOL_PATH), {
        mcp_server_instance_id: input.id,
      }),
    );
  }

  #toMcpServer(raw: RawMcpServer): McpServer {
    const server: McpServer = {
      id: raw.id,
      name: raw.name,
      teamId: raw.team_id ?? this.#config.teamId,
      isDynamicToolDiscovery: raw.is_dynamic_tool_discovery ?? false,
      tools: raw.tools ?? [],
      url: this.getServerUrl({ id: raw.id }),
    };
    if (raw.org_id) {
      server.orgId = raw.org_id;
    }
    return server;
  }
}
