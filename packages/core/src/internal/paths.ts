import { teamPath as tildeTeamPath } from "@trytilde/api-client";
import type { NormalizedConfig } from "../config";

export function teamPath(config: NormalizedConfig, path: string): string {
  return path.includes("{team_id}")
    ? path.replace("{team_id}", encodeURIComponent(config.teamId))
    : tildeTeamPath({ teamId: config.teamId }, path);
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
  config: NormalizedConfig,
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
