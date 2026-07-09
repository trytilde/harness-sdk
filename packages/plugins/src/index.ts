import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import checkbox from "@inquirer/checkbox";
import {
  type Client,
  type CloudWhoamiResponse,
  createTildeApiClient,
  getSkillRegistrySkill,
  listMcpServerInstances,
  listSkillRegistries,
  listSkillRegistrySkillSummaries,
  type McpServerInstanceSerializedWithFunctionsPaginatedResponse,
  mcpServerUrl,
  type Skill,
  type SkillRegistryPaginatedResponse,
  type SkillSummaryPaginatedResponse,
  whoami,
} from "@tilde/harness-sdk/api";

export type TildePluginConfig = {
  baseUrl: string;
  teamId?: string;
  apiKey?: string;
  accessToken?: string;
  fetch?: typeof fetch;
  logger?: Pick<NodeJS.WriteStream, "write">;
};

export type AgentCli = "claude" | "codex" | "cursor" | "opencode" | "gemini";

export type TildeMcpServerChoice = {
  id: string;
  label: string;
  teamId: string;
  teamName: string;
  serverName: string;
  url?: string;
};

export type TildeSkillRegistryChoice = {
  id: string;
  label: string;
  teamId: string;
  teamName: string;
  registryName: string;
  description?: string;
};

export type TildeTeamChoice = {
  teamId: string;
  teamName: string;
  orgId?: string;
};

export async function listTildeTeamChoices(
  config: TildePluginConfig,
  input?: { teamName?: string },
): Promise<TildeTeamChoice[]> {
  if (config.teamId) {
    return [
      {
        teamId: config.teamId,
        teamName: input?.teamName ?? config.teamId,
      },
    ];
  }
  const api = createPluginApiClient(config);
  const response = await apiCall<CloudWhoamiResponse>(whoami({ client: api }));
  return response.teams.map((team) => ({
    teamId: team.team_id,
    teamName: team.name ?? team.team_id,
    ...(team.org_id ? { orgId: team.org_id } : {}),
  }));
}

export async function listTildeMcpServerChoices(
  config: TildePluginConfig,
  input?: { teamName?: string; teams?: TildeTeamChoice[] },
): Promise<TildeMcpServerChoice[]> {
  const teams = input?.teams ?? (await listTildeTeamChoices(config, input));
  const api = createPluginApiClient(config);
  const results = await Promise.all(
    teams.map(async (team) => {
      const response =
        await apiCall<McpServerInstanceSerializedWithFunctionsPaginatedResponse>(
          listMcpServerInstances({
            client: api,
            path: { team_id: team.teamId },
            query: { page_size: 100 },
          }),
        );
      return response.items.map((server) => ({
        id: server.id,
        serverName: server.name,
        teamId: team.teamId,
        teamName: team.teamName,
        label: `${team.teamName} / ${server.name}`,
        url: mcpServerUrl({
          baseUrl: config.baseUrl,
          teamId: team.teamId,
          serverId: server.id,
        }),
      }));
    }),
  );
  return results.flat();
}

export async function listTildeSkillRegistryChoices(
  config: TildePluginConfig,
  input?: { teamName?: string; teams?: TildeTeamChoice[] },
): Promise<TildeSkillRegistryChoice[]> {
  const teams = input?.teams ?? (await listTildeTeamChoices(config, input));
  const api = createPluginApiClient(config);
  const results = await Promise.all(
    teams.map(async (team) => {
      const response = await apiCall<SkillRegistryPaginatedResponse>(
        listSkillRegistries({
          client: api,
          path: { team_id: team.teamId },
          query: { page_size: 100 },
        }),
      );
      return response.items.map((registry) => ({
        id: registry.id,
        registryName: registry.name,
        teamId: team.teamId,
        teamName: team.teamName,
        label: `${team.teamName} / ${registry.name}`,
        ...(registry.description ? { description: registry.description } : {}),
      }));
    }),
  );
  return results.flat();
}

export async function selectTildeSessionResources(
  config: TildePluginConfig,
  input?: { teamName?: string; interactive?: boolean },
): Promise<{
  mcpServers: TildeMcpServerChoice[];
  skillRegistries: TildeSkillRegistryChoice[];
}> {
  const teams = await listTildeTeamChoices(config, input);
  const [mcpServers, skillRegistries] = await Promise.all([
    listTildeMcpServerChoices(config, { ...input, teams }),
    listTildeSkillRegistryChoices(config, { ...input, teams }),
  ]);
  if (input?.interactive === false) {
    return { mcpServers, skillRegistries };
  }
  const logger = config.logger ?? process.stderr;
  logger.write(
    `Discovered ${teams.length} Tilde team${teams.length === 1 ? "" : "s"}, ${mcpServers.length} MCP server${mcpServers.length === 1 ? "" : "s"}, ${skillRegistries.length} skill registr${skillRegistries.length === 1 ? "y" : "ies"}.\n`,
  );
  return {
    mcpServers: await multiSelect("Tilde MCP servers", mcpServers, logger),
    skillRegistries: await multiSelect(
      "Tilde skill registries",
      skillRegistries,
      logger,
    ),
  };
}

export async function downloadSkillRegistry(
  config: TildePluginConfig,
  input: {
    registryId: string;
    outputDir: string;
    metadata?: TildeSkillRegistryChoice;
  },
): Promise<string[]> {
  const teamId = input.metadata?.teamId ?? config.teamId;
  if (!teamId) {
    throw new Error("Cannot download skill registry without a team id");
  }
  const api = createPluginApiClient(config);
  const summaries = await apiCall<SkillSummaryPaginatedResponse>(
    listSkillRegistrySkillSummaries({
      client: api,
      path: { team_id: teamId, id: input.registryId },
      query: { page_size: 100 },
    }),
  );
  const written: string[] = [];
  for (const summary of summaries.items) {
    const skill = await apiCall<Skill>(
      getSkillRegistrySkill({
        client: api,
        path: { team_id: teamId, id: input.registryId, skill_id: summary.id },
      }),
    );
    const skillDir = join(input.outputDir, skill.name);
    await mkdir(skillDir, { recursive: true });
    const path = join(skillDir, "SKILL.md");
    await writeFile(path, toSkillMarkdown(skill, input.metadata), "utf8");
    written.push(path);
  }
  return written;
}

export function mcpServerConfigForCli(
  cli: AgentCli,
  server: TildeMcpServerChoice,
): Record<string, unknown> {
  const url = server.url;
  if (!url) {
    throw new Error(`MCP server ${server.label} does not include a URL`);
  }
  switch (cli) {
    case "claude":
    case "codex":
    case "cursor":
    case "opencode":
    case "gemini":
      return {
        name: server.label,
        transport: "streamable_http",
        url,
      };
  }
}

export function cliMcpConfigPath(cli: AgentCli, homeDir: string): string {
  switch (cli) {
    case "claude":
      return join(homeDir, ".claude", "mcp.json");
    case "codex":
      return join(homeDir, ".codex", "mcp.json");
    case "cursor":
      return join(homeDir, ".cursor", "mcp.json");
    case "opencode":
      return join(homeDir, ".config", "opencode", "mcp.json");
    case "gemini":
      return join(homeDir, ".gemini", "settings.json");
  }
}

export function cliSkillInstallDir(cli: AgentCli, homeDir: string): string {
  switch (cli) {
    case "claude":
      return join(homeDir, ".claude", "skills");
    case "codex":
      return join(homeDir, ".codex", "skills");
    case "cursor":
      return join(homeDir, ".cursor", "skills");
    case "opencode":
      return join(homeDir, ".config", "opencode", "skills");
    case "gemini":
      return join(homeDir, ".gemini", "skills");
  }
}

export function mcpConfigDocumentForCli(
  cli: AgentCli,
  servers: TildeMcpServerChoice[],
): Record<string, unknown> {
  const entries = Object.fromEntries(
    servers.map((server) => [server.label, mcpServerConfigForCli(cli, server)]),
  );
  switch (cli) {
    case "codex":
      return { mcp_servers: entries };
    case "opencode":
      return { mcp: entries };
    case "gemini":
      return { mcpServers: entries };
    case "claude":
    case "cursor":
      return { mcpServers: entries };
  }
}

export async function writeMcpConfigForCli(
  cli: AgentCli,
  input: { homeDir: string; servers: TildeMcpServerChoice[] },
): Promise<string> {
  const path = cliMcpConfigPath(cli, input.homeDir);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(mcpConfigDocumentForCli(cli, input.servers), null, 2)}\n`,
    "utf8",
  );
  return path;
}

export async function installSkillRegistriesForCli(
  cli: AgentCli,
  config: TildePluginConfig,
  input: { homeDir: string; registries: TildeSkillRegistryChoice[] },
): Promise<string[]> {
  const root = cliSkillInstallDir(cli, input.homeDir);
  const tmp = `${root}.tmp-${Date.now()}`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const written: string[] = [];
  for (const registry of input.registries) {
    const registryDir = join(tmp, registry.registryName);
    written.push(
      ...(await downloadSkillRegistry(config, {
        registryId: registry.id,
        outputDir: registryDir,
        metadata: registry,
      })),
    );
  }
  await rm(root, { recursive: true, force: true });
  await rename(tmp, root);
  return written.map((path) => path.replace(tmp, root));
}

export async function configureTildeSessionForCli(
  cli: AgentCli,
  config: TildePluginConfig,
  input: {
    homeDir: string;
    teamName?: string;
    interactive?: boolean;
    mcpServers?: TildeMcpServerChoice[];
    skillRegistries?: TildeSkillRegistryChoice[];
  },
): Promise<{
  mcpConfigPath: string;
  mcpServerCount: number;
  skillFiles: string[];
}> {
  const selected =
    input.mcpServers || input.skillRegistries
      ? {
          mcpServers: input.mcpServers ?? [],
          skillRegistries: input.skillRegistries ?? [],
        }
      : await selectTildeSessionResources(config, {
          ...(input.teamName ? { teamName: input.teamName } : {}),
          ...(typeof input.interactive === "boolean"
            ? { interactive: input.interactive }
            : {}),
        });
  const [mcpConfigPath, skillFiles] = await Promise.all([
    writeMcpConfigForCli(cli, {
      homeDir: input.homeDir,
      servers: selected.mcpServers,
    }),
    installSkillRegistriesForCli(cli, config, {
      homeDir: input.homeDir,
      registries: selected.skillRegistries,
    }),
  ]);
  return {
    mcpConfigPath,
    mcpServerCount: selected.mcpServers.length,
    skillFiles,
  };
}

function createPluginApiClient(config: TildePluginConfig): Client {
  const options = {
    baseUrl: config.baseUrl,
  };
  const token = config.apiKey ?? config.accessToken;
  return createTildeApiClient({
    ...options,
    ...(token ? { bearerToken: token } : {}),
    ...(config.fetch ? { fetch: config.fetch } : {}),
  });
}

async function apiCall<T>(
  promise: Promise<{
    data?: T | undefined;
    error?: unknown;
    response?: Response;
  }>,
): Promise<T> {
  try {
    const result = await promise;
    if (result.error !== undefined) throw result.error;
    if (result.data === undefined) {
      throw new Error("Tilde response did not include data");
    }
    return result.data as T;
  } catch (error) {
    throw new Error(`Tilde request failed: ${formatFetchError(error)}`);
  }
}

async function multiSelect<T extends { label: string }>(
  title: string,
  items: T[],
  logger: Pick<NodeJS.WriteStream, "write"> = process.stderr,
): Promise<T[]> {
  if (items.length === 0) {
    logger.write(`No ${title.toLowerCase()} found.\n`);
    return [];
  }
  return checkbox<T>({
    message: title,
    choices: items.map((item) => ({
      name: item.label,
      value: item,
      checked: true,
    })),
    pageSize: Math.min(12, Math.max(5, items.length)),
    loop: false,
    required: false,
  });
}

function toSkillMarkdown(
  skill: Skill,
  registry?: TildeSkillRegistryChoice,
): string {
  const metadata = registry
    ? `\n<!-- tilde-registry-id: ${registry.id} -->\n<!-- tilde-registry-label: ${registry.label} -->\n`
    : "";
  return `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n${metadata}\n${skill.content.trim()}\n`;
}

function formatFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause instanceof Error) {
    const code = "code" in cause ? ` ${(cause as { code?: string }).code}` : "";
    const address =
      "address" in cause ? ` ${(cause as { address?: string }).address}` : "";
    const port = "port" in cause ? `:${(cause as { port?: number }).port}` : "";
    return `${error.message}; caused by ${cause.message}${code}${address}${port}`;
  }
  return error.message;
}
