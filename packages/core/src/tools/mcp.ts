import { mcpServerUrl } from "@tilde/api-client";
import type { NormalizedConfig } from "../config";
import { requestJson } from "../internal/fetch-client";
import { pathWithParams, teamPath } from "../internal/paths";
import {
  type JsonObject,
  type JsonValue,
  type LocalMcpTool,
  type LocalMcpToolsClient,
  type RegisterLocalMcpToolsRequest,
  type ToolResult,
  wrapMcpClientWithLocalTools,
} from "./local";

const MCP_SERVER_PATH = "/api/v1/team/{team_id}/mcp/mcp-server";
const MCP_SERVER_INSTANCE_PATH =
  "/api/v1/team/{team_id}/mcp/mcp-server/{mcp_server_instance_id}";
const AVAILABLE_TOOL_GROUPS_PATH =
  "/api/v1/team/{team_id}/mcp/available-tool-groups";
const CREATE_TOOL_GROUP_PATH =
  "/api/v1/team/{team_id}/mcp/available-tool-groups/{tool_group_source_type_id}/available-credentials/{credential_source_type_id}";
const TOOL_GROUP_PATH =
  "/api/v1/team/{team_id}/mcp/tool-group/{tool_group_instance_id}";
const TOOL_PATH =
  "/api/v1/team/{team_id}/mcp/tool-group/{tool_group_instance_id}/tool/{tool_source_type_id}";
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
  tools: McpToolDefinition[];
};

export type McpToolDefinition = JsonObject & {
  name?: string;
  description?: string;
  input_schema?: JsonObject;
  inputSchema?: JsonObject;
  output_schema?: JsonObject;
  outputSchema?: JsonObject;
};

export type AvailableToolGroup = JsonObject & {
  id?: string;
  name?: string;
  display_name?: string;
  source_type_id?: string;
};

export type ToolGroupInstance = JsonObject & {
  id?: string;
  tool_group_instance_id?: string;
  display_name?: string;
};

export type ToolDeployment = JsonObject & {
  id?: string;
  alias?: string;
  name?: string;
};

export type AddMcpServerFunctionInput = {
  serverId: string;
  toolSourceTypeId: string;
  toolGroupSourceTypeId: string;
  toolGroupInstanceId: string;
  toolName: string;
  toolDescription?: string | null;
};

export type UpdateMcpServerInput = {
  id: string;
  name: string;
  isDynamicToolDiscovery: boolean;
};

export type CreateToolGroupInput = {
  toolGroupSourceTypeId: string;
  credentialSourceTypeId: string;
  displayName: string;
  toolGroupInstanceId?: string | null;
  resourceServerCredentialId?: string | null;
  userCredentialId?: string | null;
  returnOnSuccessfulBrokering?: JsonValue;
};

export type EnableMcpToolInput = {
  toolGroupInstanceId: string;
  toolSourceTypeId: string;
  boundParams?: JsonValue;
};

type RawMcpServer = {
  id: string;
  name: string;
  org_id?: string;
  team_id?: string;
  is_dynamic_tool_discovery?: boolean;
  tools?: McpToolDefinition[];
};

type Paginated<T> = {
  items: T[];
  next_page_token?: string | null;
};

export class McpClient {
  readonly #config: NormalizedConfig;

  constructor(config: NormalizedConfig) {
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

  async updateServer(input: UpdateMcpServerInput): Promise<McpServer> {
    const raw = await requestJson<RawMcpServer>(this.#config, {
      method: "PATCH",
      path: pathWithParams(teamPath(this.#config, MCP_SERVER_INSTANCE_PATH), {
        mcp_server_instance_id: input.id,
      }),
      body: {
        name: input.name,
        is_dynamic_tool_discovery: input.isDynamicToolDiscovery,
      },
    });
    return this.#toMcpServer(raw);
  }

  async deleteServer(input: { id: string }): Promise<void> {
    await requestJson<void>(this.#config, {
      method: "DELETE",
      path: pathWithParams(teamPath(this.#config, MCP_SERVER_INSTANCE_PATH), {
        mcp_server_instance_id: input.id,
      }),
    });
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
  }): Promise<{ items: AvailableToolGroup[]; nextPageToken?: string }> {
    const raw = await requestJson<Paginated<AvailableToolGroup>>(this.#config, {
      path: teamPath(this.#config, AVAILABLE_TOOL_GROUPS_PATH),
      query: {
        page_size: input?.pageSize ?? 100,
        next_page_token: input?.nextPageToken,
        deployment_alias: input?.deploymentAlias ?? "latest",
      },
    });
    return paginated(raw);
  }

  async createToolGroup<TResult extends ToolGroupInstance = ToolGroupInstance>(
    input: CreateToolGroupInput,
  ): Promise<TResult> {
    return requestJson<TResult>(this.#config, {
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

  async deleteToolGroup(input: { id: string }): Promise<void> {
    await requestJson<void>(this.#config, {
      method: "DELETE",
      path: pathWithParams(teamPath(this.#config, TOOL_GROUP_PATH), {
        tool_group_instance_id: input.id,
      }),
    });
  }

  async enableTool<TResult extends JsonObject = JsonObject>(
    input: EnableMcpToolInput,
  ): Promise<TResult> {
    return requestJson<TResult>(this.#config, {
      method: "POST",
      path: `${pathWithParams(teamPath(this.#config, TOOL_PATH), {
        tool_group_instance_id: input.toolGroupInstanceId,
        tool_source_type_id: input.toolSourceTypeId,
      })}/enable`,
      body: {
        bound_params: input.boundParams,
      },
    });
  }

  async listToolDeploymentsByAlias(input: {
    alias: string;
    pageSize?: number;
    nextPageToken?: string;
  }): Promise<{ items: ToolDeployment[]; nextPageToken?: string }> {
    const raw = await requestJson<Paginated<ToolDeployment>>(this.#config, {
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
    return paginated(raw);
  }

  getServerUrl(input: { id: string }): string {
    if (!this.#config.baseUrl) {
      throw new TypeError("baseUrl is required to build an MCP server URL");
    }
    return mcpServerUrl({
      baseUrl: this.#config.baseUrl,
      teamId: this.#config.teamId,
      serverId: input.id,
    });
  }

  withLocalTools<TClient extends object>(input: {
    client: TClient;
    serverId: string;
    tools: LocalMcpTool[];
    registerWithServer?: boolean;
    registerLocalTools?: (
      request: RegisterLocalMcpToolsRequest,
    ) => Promise<ToolResult>;
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

function paginated<TItem>(raw: Paginated<TItem>): {
  items: TItem[];
  nextPageToken?: string;
} {
  const result: { items: TItem[]; nextPageToken?: string } = {
    items: raw.items,
  };
  if (raw.next_page_token) {
    result.nextPageToken = raw.next_page_token;
  }
  return result;
}
