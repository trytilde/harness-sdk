import type { Config } from "../config";

export function teamPath(config: Config, path: string): string {
  return path.replace("{team_id}", encodeURIComponent(config.teamId));
}

export function pathWithParams(
  path: string,
  params: Record<string, string>,
): string {
  let next = path;
  for (const [key, value] of Object.entries(params)) {
    next = next.replace(`{${key}}`, encodeURIComponent(value));
  }
  return next;
}

export function buildUrl(
  config: Config,
  path: string,
  query?: Record<string, string | number | boolean | null | undefined>,
): string {
  const url = new URL(path, `${config.baseUrl}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}
