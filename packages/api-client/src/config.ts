import { type Client, createClient } from "./generated/client";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | { [key: string]: JsonValue } | JsonValue[] | undefined;

export type TildeApiClientOptions = {
  baseUrl: string;
  bearerToken?: string;
  apiKey?: string;
  orgId?: string;
  headers?: HeadersInit;
  fetch?: typeof fetch;
  throwOnError?: boolean;
};

export type TildeApiClient = Client;

export function createTildeApiClient(
  options: TildeApiClientOptions,
): TildeApiClient {
  const headers = new Headers(options.headers);
  const token = options.bearerToken ?? options.apiKey;
  if (token && !headers.has("Authorization") && !headers.has("x-api-key")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  if (options.orgId && !headers.has("x-tilde-org-id")) {
    headers.set("x-tilde-org-id", options.orgId);
  }

  const config = {
    baseUrl: trimTrailingSlash(options.baseUrl),
    headers,
    throwOnError: options.throwOnError ?? true,
  };
  if (options.fetch) {
    return createClient({ ...config, fetch: options.fetch });
  }
  return createClient(config);
}

export async function unwrapTildeResponse<T>(
  promise: Promise<{ data?: T; error?: JsonValue; response?: Response }>,
): Promise<T> {
  const result = await promise;
  if ("error" in result && result.error !== undefined) {
    throw result.error;
  }
  if (result.data === undefined) {
    throw new Error("Tilde response did not include data");
  }
  return result.data as T;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
