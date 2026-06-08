export type Config = {
  baseUrl: string;
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
  if (!input.baseUrl || input.baseUrl.trim().length === 0) {
    throw new TypeError("baseUrl is required");
  }
  if (!input.teamId || input.teamId.trim().length === 0) {
    throw new TypeError("teamId is required");
  }

  let url: URL;
  try {
    url = new URL(input.baseUrl);
  } catch {
    throw new TypeError("baseUrl must be an absolute URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("baseUrl must use http or https");
  }

  const baseUrl = input.baseUrl.replace(/\/+$/, "");
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
