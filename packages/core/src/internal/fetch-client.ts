import type { NormalizedConfig } from "../config";
import { configFetch, configHeaders } from "../config";
import { errorFromResponse } from "../errors";
import type { JsonValue } from "../tools";
import { buildUrl } from "./paths";

export type RequestOptions = {
  method?: string;
  path: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: JsonValue;
  headers?: HeadersInit;
};

export async function requestJson<T>(
  config: NormalizedConfig,
  options: RequestOptions,
): Promise<T> {
  const headers = configHeaders(config);
  const extraHeaders = new Headers(options.headers);
  for (const [key, value] of extraHeaders.entries()) {
    headers.set(key, value);
  }

  const init: RequestInit = {
    method: options.method ?? "GET",
    headers,
  };

  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(options.body);
  }

  const response = await configFetch(config)(
    buildUrl(config, options.path, options.query),
    init,
  );
  if (!response.ok) {
    throw await errorFromResponse(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
