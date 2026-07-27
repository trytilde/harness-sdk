export type Config = {
  baseUrl?: string;
  baseApiUrl?: string;
  orgId?: string;
  orgSubdomain?: boolean;
  teamId?: string;
  apiKey?: string;
  tunnel?: boolean;
  cloudflaredPath?: string;
  bearerToken?: string;
  fetch?: typeof fetch;
  headers?: HeadersInit;
};

export type NormalizedConfig = Omit<Config, "baseUrl" | "teamId"> & {
  baseUrl: string;
  teamId: string;
};

export function createConfig(input: Config = {}): NormalizedConfig {
  const headers = new Headers(input.headers);
  const baseUrlInput =
    input.baseUrl ??
    baseUrlFromOrgId(input.orgId ?? env("TILDE_ORG_ID"), input.baseApiUrl) ??
    env("TILDE_BASE_URL") ??
    "https://api.trytilde.ai";
  const teamId = input.teamId ?? env("TILDE_TEAM_ID");
  if (!teamId || teamId.trim().length === 0) {
    throw new TypeError("teamId is required");
  }
  const bearerToken = input.bearerToken ?? env("TILDE_BEARER_TOKEN");
  const apiKey = input.apiKey ?? env("TILDE_API_KEY");
  if (!bearerToken && !apiKey && !hasAuthHeader(headers)) {
    throw new TypeError("apiKey or bearerToken is required");
  }

  let url: URL;
  try {
    url = new URL(baseUrlInput);
  } catch {
    throw new TypeError("baseUrl must be an absolute URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("baseUrl must use http or https");
  }

  const baseUrl =
    input.orgSubdomain === false
      ? baseUrlInput.replace(/\/+$/, "")
      : canonicalizeBaseUrlForOrg(baseUrlInput, input.orgId);
  return {
    ...input,
    baseUrl,
    teamId: teamId.trim(),
    ...(apiKey ? { apiKey } : {}),
    ...(bearerToken ? { bearerToken } : {}),
  };
}

export function configHeaders(config: Config): Headers {
  const headers = new Headers(config.headers);
  if (
    config.orgSubdomain === false &&
    config.orgId &&
    !headers.has("x-tilde-org-id")
  ) {
    headers.set("x-tilde-org-id", config.orgId);
  }
  const token = config.bearerToken ?? config.apiKey;
  const hasExplicitApiKeyHeader = headers.has("x-api-key");
  if (token && !headers.has("Authorization") && !hasExplicitApiKeyHeader) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
}

export function configFetch(config: Config): typeof fetch {
  if (config.fetch) {
    return config.fetch;
  }
  if (typeof fetch === "undefined") {
    throw new TypeError("No fetch implementation is available");
  }
  return fetch;
}

function baseUrlFromOrgId(
  orgId: string | undefined,
  configuredBaseApiUrl: string | undefined,
): string | undefined {
  if (!orgId || orgId.trim().length === 0) {
    return undefined;
  }
  const normalizedOrgId = orgId.trim();
  if (!isValidHostnameLabel(normalizedOrgId)) {
    throw new TypeError(
      "orgId must be a valid hostname label using letters, numbers, or hyphens",
    );
  }
  const apiUrl = new URL(baseApiUrl(configuredBaseApiUrl));
  apiUrl.hostname = `${normalizedOrgId}.${apiUrl.hostname}`;
  return apiUrl.toString();
}

function canonicalizeBaseUrlForOrg(
  baseUrl: string,
  orgId: string | undefined,
): string {
  const trimmedBaseUrl = baseUrl.replace(/\/+$/, "");
  if (!orgId || orgId.trim().length === 0) {
    return trimmedBaseUrl;
  }
  const normalizedOrgId = orgId.trim();
  if (!isValidHostnameLabel(normalizedOrgId)) {
    throw new TypeError(
      "orgId must be a valid hostname label using letters, numbers, or hyphens",
    );
  }
  const url = new URL(trimmedBaseUrl);
  if (
    url.hostname === normalizedOrgId ||
    url.hostname.startsWith(`${normalizedOrgId}.`)
  ) {
    return url.toString().replace(/\/+$/, "");
  }
  url.hostname = `${normalizedOrgId}.${url.hostname}`;
  return url.toString().replace(/\/+$/, "");
}

function isValidHostnameLabel(value: string): boolean {
  return (
    value.length <= 63 &&
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(value)
  );
}

function baseApiUrl(configuredBaseApiUrl: string | undefined): string {
  return (
    configuredBaseApiUrl ??
    env("TILDE_BASE_API_URL") ??
    "https://api.trytilde.ai"
  );
}

function env(name: string): string | undefined {
  if (typeof process === "undefined") {
    return undefined;
  }
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

function hasAuthHeader(headers: Headers): boolean {
  return headers.has("Authorization") || headers.has("x-api-key");
}
