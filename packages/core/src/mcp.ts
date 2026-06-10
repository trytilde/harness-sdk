import type { Config } from "./config";
import { requestJson } from "./internal/fetch-client";
import { buildUrl, pathWithParams, teamPath } from "./internal/paths";
import {
  type LocalMcpTool,
  type LocalMcpToolsClient,
  wrapMcpClientWithLocalTools,
} from "./mcp-local-tools";

const MCP_SERVER_PATH = "/api/v1/team/{team_id}/mcp/mcp-server";
const MCP_SERVER_INSTANCE_PATH =
  "/api/v1/team/{team_id}/mcp/mcp-server/{mcp_server_instance_id}";
const MCP_PROTOCOL_PATH =
  "/api/v1/team/{team_id}/mcp/mcp-server/{mcp_server_instance_id}/mcp";
const AVAILABLE_TOOL_GROUPS_PATH =
  "/api/v1/team/{team_id}/mcp/available-tool-groups";
const CREATE_TOOL_GROUP_PATH =
  "/api/v1/team/{team_id}/mcp/available-tool-groups/{tool_group_source_type_id}/available-credentials/{credential_source_type_id}";
const TOOL_DEPLOYMENTS_BY_ALIAS_PATH =
  "/api/v1/team/{team_id}/mcp/tool-deployments/{alias}";

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

export type AddMcpServerFunctionInput = {
  serverId: string;
  toolSourceTypeId: string;
  toolGroupSourceTypeId: string;
  toolGroupInstanceId: string;
  toolName: string;
  toolDescription?: string | null;
};

export type CreateToolGroupInput = {
  toolGroupSourceTypeId: string;
  credentialSourceTypeId: string;
  displayName: string;
  toolGroupInstanceId?: string | null;
  resourceServerCredentialId?: string | null;
  userCredentialId?: string | null;
  returnOnSuccessfulBrokering?: unknown;
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

  async addFunction(input: AddMcpServerFunctionInput): Promise<McpServer> {
    const raw = await requestJson<RawMcpServer>(this.#config, {
      method: "POST",
      path: pathWithParams(
        teamPath(this.#config, `${MCP_SERVER_INSTANCE_PATH}/function`),
        {
          mcp_server_instance_id: input.serverId,
        },
      ),
      body: {
        tool_source_type_id: input.toolSourceTypeId,
        tool_group_source_type_id: input.toolGroupSourceTypeId,
        tool_group_instance_id: input.toolGroupInstanceId,
        tool_name: input.toolName,
        tool_description: input.toolDescription,
      },
    });
    return this.#toMcpServer(raw);
  }

  async listAvailableToolGroups(input?: {
    deploymentAlias?: string;
    pageSize?: number;
    nextPageToken?: string;
  }): Promise<{ items: unknown[]; nextPageToken?: string }> {
    const raw = await requestJson<Paginated<unknown>>(this.#config, {
      path: teamPath(this.#config, AVAILABLE_TOOL_GROUPS_PATH),
      query: {
        page_size: input?.pageSize ?? 100,
        next_page_token: input?.nextPageToken,
        deployment_alias: input?.deploymentAlias ?? "latest",
      },
    });
    return paginatedUnknown(raw);
  }

  async createToolGroup(input: CreateToolGroupInput): Promise<unknown> {
    return requestJson<unknown>(this.#config, {
      method: "POST",
      path: pathWithParams(teamPath(this.#config, CREATE_TOOL_GROUP_PATH), {
        tool_group_source_type_id: input.toolGroupSourceTypeId,
        credential_source_type_id: input.credentialSourceTypeId,
      }),
      body: {
        display_name: input.displayName,
        tool_group_instance_id: input.toolGroupInstanceId,
        resource_server_credential_id: input.resourceServerCredentialId,
        user_credential_id: input.userCredentialId,
        return_on_successful_brokering: input.returnOnSuccessfulBrokering,
      },
    });
  }

  async listToolDeploymentsByAlias(input: {
    alias: string;
    pageSize?: number;
    nextPageToken?: string;
  }): Promise<{ items: unknown[]; nextPageToken?: string }> {
    const raw = await requestJson<Paginated<unknown>>(this.#config, {
      path: pathWithParams(
        teamPath(this.#config, TOOL_DEPLOYMENTS_BY_ALIAS_PATH),
        {
          alias: input.alias,
        },
      ),
      query: {
        page_size: input.pageSize ?? 100,
        next_page_token: input.nextPageToken,
      },
    });
    return paginatedUnknown(raw);
  }

  getServerUrl(input: { id: string }): string {
    return buildUrl(
      this.#config,
      pathWithParams(teamPath(this.#config, MCP_PROTOCOL_PATH), {
        mcp_server_instance_id: input.id,
      }),
    );
  }

  withLocalTools<TClient extends object>(input: {
    client: TClient;
    serverId: string;
    tools: LocalMcpTool[];
    registerWithServer?: boolean;
  }): LocalMcpToolsClient<TClient> {
    return wrapMcpClientWithLocalTools(input);
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

function paginatedUnknown(raw: Paginated<unknown>): {
  items: unknown[];
  nextPageToken?: string;
} {
  const result: { items: unknown[]; nextPageToken?: string } = {
    items: raw.items,
  };
  if (raw.next_page_token) {
    result.nextPageToken = raw.next_page_token;
  }
  return result;
}
