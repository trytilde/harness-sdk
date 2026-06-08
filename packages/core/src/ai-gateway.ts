import type { Config } from "./config";
import { requestJson } from "./internal/fetch-client";
import { buildUrl, pathWithParams, teamPath } from "./internal/paths";

const PROFILE_PATH = "/api/v1/team/{team_id}/ai-gateway/profile";
const PROFILE_INSTANCE_PATH =
  "/api/v1/team/{team_id}/ai-gateway/profile/{profile_id}";
const PROVIDER_PATH = "/api/v1/team/{team_id}/ai-gateway/provider";
const CREDENTIAL_PROXY_PATH =
  "/api/v1/team/{team_id}/credential-proxy/{profile_id}/{rest}";

export type ProfileKind = "chat" | "embedding";

export type AiGatewayProfile = {
  id: string;
  providerId: string;
  baseUrl: string;
  resourceServerCredentialId: string;
  userCredentialId?: string | null;
  kind: ProfileKind;
  model?: string | null;
  ownerId?: string | null;
  orgId: string;
  teamId: string;
  customHeaders: Record<string, string>;
  createdAt?: unknown;
  updatedAt?: unknown;
};

export type AiGatewayProvider = {
  id: string;
  name: string;
  baseUrl: string;
  supportedCredentials: unknown[];
  availableChatModels: unknown[];
  availableEmbeddingModels: unknown[];
  docsUrl?: string | null;
  icon?: string | null;
  shortDescription?: string | null;
};

export type CreateProfileInput = {
  id: string;
  providerId: string;
  resourceServerCredentialId: string;
  kind: ProfileKind;
  model?: string | null;
  baseUrlOverride?: string | null;
  ownerId?: string | null;
  userCredentialId?: string | null;
  customHeaders?: Record<string, string>;
};

export type UpdateProfileInput = {
  id: string;
  model?: string | null;
  baseUrl?: string | null;
  resourceServerCredentialId?: string | null;
  userCredentialId?: string | null;
  customHeaders?: Record<string, string> | null;
};

type RawProfile = {
  id: string;
  provider_id: string;
  base_url: string;
  resource_server_credential_id: string;
  user_credential_id?: string | null;
  kind: ProfileKind;
  model?: string | null;
  owner_id?: string | null;
  org_id: string;
  team_id: string;
  custom_headers?: Record<string, string>;
  created_at?: unknown;
  updated_at?: unknown;
};

type RawProvider = {
  id: string;
  name: string;
  base_url: string;
  supported_credentials: unknown[];
  available_chat_models: unknown[];
  available_embedding_models: unknown[];
  docs_url?: string | null;
  icon?: string | null;
  short_description?: string | null;
};

type Paginated<T> = {
  items: T[];
  next_page_token?: string | null;
};

export class AiGatewayClient {
  readonly #config: Config;

  constructor(config: Config) {
    this.#config = config;
  }

  async listProviders(): Promise<{ items: AiGatewayProvider[] }> {
    const raw = await requestJson<{ items: RawProvider[] }>(this.#config, {
      path: teamPath(this.#config, PROVIDER_PATH),
    });
    return { items: raw.items.map(toProvider) };
  }

  async createProfile(input: CreateProfileInput): Promise<AiGatewayProfile> {
    const raw = await requestJson<RawProfile>(this.#config, {
      method: "POST",
      path: teamPath(this.#config, PROFILE_PATH),
      body: {
        id: input.id,
        provider_id: input.providerId,
        resource_server_credential_id: input.resourceServerCredentialId,
        kind: input.kind,
        model: input.model,
        base_url_override: input.baseUrlOverride,
        owner_id: input.ownerId,
        user_credential_id: input.userCredentialId,
        custom_headers: input.customHeaders ?? {},
      },
    });
    return toProfile(raw);
  }

  async listProfiles(input?: {
    pageSize?: number;
    nextPageToken?: string;
    kind?: ProfileKind;
  }): Promise<{ items: AiGatewayProfile[]; nextPageToken?: string }> {
    const raw = await requestJson<Paginated<RawProfile>>(this.#config, {
      path: teamPath(this.#config, PROFILE_PATH),
      query: {
        page_size: input?.pageSize ?? 50,
        next_page_token: input?.nextPageToken,
        kind: input?.kind,
      },
    });
    const result: { items: AiGatewayProfile[]; nextPageToken?: string } = {
      items: raw.items.map(toProfile),
    };
    if (raw.next_page_token) {
      result.nextPageToken = raw.next_page_token;
    }
    return result;
  }

  async getProfile(input: { id: string }): Promise<AiGatewayProfile> {
    const raw = await requestJson<RawProfile>(this.#config, {
      path: pathWithParams(teamPath(this.#config, PROFILE_INSTANCE_PATH), {
        profile_id: input.id,
      }),
    });
    return toProfile(raw);
  }

  async updateProfile(input: UpdateProfileInput): Promise<AiGatewayProfile> {
    const raw = await requestJson<RawProfile>(this.#config, {
      method: "PATCH",
      path: pathWithParams(teamPath(this.#config, PROFILE_INSTANCE_PATH), {
        profile_id: input.id,
      }),
      body: {
        model: input.model,
        base_url: input.baseUrl,
        resource_server_credential_id: input.resourceServerCredentialId,
        user_credential_id: input.userCredentialId,
        custom_headers: input.customHeaders,
      },
    });
    return toProfile(raw);
  }

  async deleteProfile(input: { id: string }): Promise<void> {
    await requestJson<void>(this.#config, {
      method: "DELETE",
      path: pathWithParams(teamPath(this.#config, PROFILE_INSTANCE_PATH), {
        profile_id: input.id,
      }),
    });
  }

  credentialProxyUrl(input: { profileId: string; rest?: string }): string {
    return buildUrl(
      this.#config,
      pathWithParams(teamPath(this.#config, CREDENTIAL_PROXY_PATH), {
        profile_id: input.profileId,
        rest: input.rest ?? "",
      }),
    );
  }

  openAiCompatibleBaseUrl(input: { profileId: string }): string {
    return this.credentialProxyUrl({ profileId: input.profileId });
  }
}

function toProfile(raw: RawProfile): AiGatewayProfile {
  const profile: AiGatewayProfile = {
    id: raw.id,
    providerId: raw.provider_id,
    baseUrl: raw.base_url,
    resourceServerCredentialId: raw.resource_server_credential_id,
    kind: raw.kind,
    orgId: raw.org_id,
    teamId: raw.team_id,
    customHeaders: raw.custom_headers ?? {},
  };
  if (raw.user_credential_id !== undefined) {
    profile.userCredentialId = raw.user_credential_id;
  }
  if (raw.model !== undefined) {
    profile.model = raw.model;
  }
  if (raw.owner_id !== undefined) {
    profile.ownerId = raw.owner_id;
  }
  if (raw.created_at !== undefined) {
    profile.createdAt = raw.created_at;
  }
  if (raw.updated_at !== undefined) {
    profile.updatedAt = raw.updated_at;
  }
  return profile;
}

function toProvider(raw: RawProvider): AiGatewayProvider {
  const provider: AiGatewayProvider = {
    id: raw.id,
    name: raw.name,
    baseUrl: raw.base_url,
    supportedCredentials: raw.supported_credentials,
    availableChatModels: raw.available_chat_models,
    availableEmbeddingModels: raw.available_embedding_models,
  };
  if (raw.docs_url !== undefined) {
    provider.docsUrl = raw.docs_url;
  }
  if (raw.icon !== undefined) {
    provider.icon = raw.icon;
  }
  if (raw.short_description !== undefined) {
    provider.shortDescription = raw.short_description;
  }
  return provider;
}
