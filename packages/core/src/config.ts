export type Config = {
  baseUrl?: string;
  baseApiUrl?: string;
  orgId?: string;
  teamId: string;
  apiKey?: string;
  bearerToken?: string;
  fetch?: typeof fetch;
  headers?: HeadersInit;
};

export type NormalizedConfig = Config & {
  baseUrl: string;
};

export function createConfig(input: Config): NormalizedConfig {
  const baseUrlInput =
    input.baseUrl ?? baseUrlFromOrgId(input.orgId, input.baseApiUrl);
  if (!baseUrlInput || baseUrlInput.trim().length === 0) {
    throw new TypeError("baseUrl or orgId is required");
  }
  if (!input.teamId || input.teamId.trim().length === 0) {
    throw new TypeError("teamId is required");
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

  const baseUrl = baseUrlInput.replace(/\/+$/, "");
  return {
    ...input,
    baseUrl,
    teamId: input.teamId.trim(),
  };
}

export function configHeaders(config: Config): Headers {
  const headers = new Headers(config.headers);
  const token = config.bearerToken ?? config.apiKey;
  if (token && !headers.has("Authorization")) {
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
  const apiUrl = new URL(baseApiUrl(configuredBaseApiUrl));
  apiUrl.hostname = `${orgId.trim()}.${apiUrl.hostname}`;
  return apiUrl.toString();
}

function baseApiUrl(configuredBaseApiUrl: string | undefined): string {
  return configuredBaseApiUrl ?? envBaseApiUrl() ?? "https://api.trytilde.com";
}

function envBaseApiUrl(): string | undefined {
  if (typeof process === "undefined") {
    return undefined;
  }
  return process.env.TILDE_BASE_API_URL;
}
