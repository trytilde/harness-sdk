import type { Config } from "./config";
import { requestJson } from "./internal/fetch-client";
import { teamPath } from "./internal/paths";

const HOSTED_AGENT_DEPLOYMENTS_PATH =
  "/api/v1/team/{team_id}/agent/platform-deployments";

export type HostedAgentDefinition = {
  id: string;
  entrypoint?: string;
  path?: string;
  description?: string;
};

export type HostedCustomToolDefinition = {
  id: string;
  entrypoint?: string;
  path?: string;
  name?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};

export type TildeAppDefinition = {
  name?: string;
  agents?: HostedAgentDefinition[];
  tools?: HostedCustomToolDefinition[];
};

export type HostedAgentEndpoint = {
  id: string;
  path: string;
  description: string;
};

export type HostedCustomToolEndpoint = {
  id: string;
  path: string;
  description: string;
};

export type HostedAgentDeploymentFile = {
  file: string;
  data: string;
};

export type DeployHostedAgentsInput = {
  projectSlug: string;
  deploymentName?: string;
  productionDomain?: string;
  agents: HostedAgentEndpoint[];
  customTools?: HostedCustomToolEndpoint[];
  files: HostedAgentDeploymentFile[];
};

export type HostedAgentsDeployment = {
  projectId: string;
  deploymentId: string;
  deploymentUrl: string;
  productionDomain?: string;
  agents: HostedAgentEndpoint[];
  customTools: HostedCustomToolEndpoint[];
};

type RawHostedAgentsDeployment = {
  project_id: string;
  deployment_id: string;
  deployment_url: string;
  production_domain?: string | null;
  agents: HostedAgentEndpoint[];
  custom_tools?: HostedCustomToolEndpoint[];
};

export function defineApp(definition: TildeAppDefinition): TildeAppDefinition {
  if (!definition.agents?.length && !definition.tools?.length) {
    throw new TypeError("defineApp requires at least one agent or tool");
  }
  return definition;
}

export function agent(
  definition: HostedAgentDefinition,
): HostedAgentDefinition {
  if (!definition.id.trim()) {
    throw new TypeError("agent id is required");
  }
  return definition;
}

export function tool(
  definition: HostedCustomToolDefinition,
): HostedCustomToolDefinition {
  if (!definition.id.trim()) {
    throw new TypeError("tool id is required");
  }
  if (!definition.description.trim()) {
    throw new TypeError("tool description is required");
  }
  return definition;
}

export class AgentsClient {
  readonly #config: Config;

  constructor(config: Config) {
    this.#config = config;
  }

  async deployHosted(
    input: DeployHostedAgentsInput,
  ): Promise<HostedAgentsDeployment> {
    const raw = await requestJson<RawHostedAgentsDeployment>(this.#config, {
      method: "POST",
      path: teamPath(this.#config, HOSTED_AGENT_DEPLOYMENTS_PATH),
      body: {
        project_slug: input.projectSlug,
        deployment_name: input.deploymentName,
        production_domain: input.productionDomain,
        agents: input.agents,
        custom_tools: input.customTools ?? [],
        files: input.files,
      },
    });
    const result: HostedAgentsDeployment = {
      projectId: raw.project_id,
      deploymentId: raw.deployment_id,
      deploymentUrl: raw.deployment_url,
      agents: raw.agents,
      customTools: raw.custom_tools ?? [],
    };
    if (raw.production_domain) {
      result.productionDomain = raw.production_domain;
    }
    return result;
  }
}
