export type TeamPathInput = {
  teamId?: string;
};

export type ReverseProxyUrlInput = TeamPathInput & {
  baseUrl?: string;
  orgId?: string;
  profileId: string;
  path?: string;
  pathPrefix?: string;
  query?: Record<string, string | number | boolean | null | undefined>;
};

export type McpServerUrlInput = TeamPathInput & {
  baseUrl: string;
  serverId: string;
};

export function teamPath(input: TeamPathInput, path: string): string {
  return `/api/v1/team/${encodeURIComponent(requiredTeamId(input.teamId))}${ensureLeadingSlash(path)}`;
}

export function mcpServerUrl(input: McpServerUrlInput): string {
  return absoluteUrl(
    input.baseUrl,
    teamPath(
      input,
      `/mcp/mcp-server/${encodeURIComponent(input.serverId)}/mcp`,
    ),
  );
}

export function reverseProxyPath(
  input: Omit<ReverseProxyUrlInput, "baseUrl">,
): string {
  const segments = [
    "/reverse-proxy",
    encodeURIComponent(input.profileId),
    normalizePathSegment(input.pathPrefix),
    normalizePathSegment(input.path),
  ].filter(Boolean);
  return teamPath(input, segments.join("/"));
}

export function reverseProxyUrl(input: ReverseProxyUrlInput): string {
  const url = new URL(
    reverseProxyPath(input),
    `${trimTrailingSlash(orgScopedBaseUrl(input))}/`,
  );
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function orgScopedBaseUrl(input: Pick<ReverseProxyUrlInput, "baseUrl" | "orgId">): string {
  const orgId = requiredOrgId(input.orgId);
  const baseUrl = input.baseUrl ?? env("TILDE_BASE_URL") ?? "https://api.trytilde.ai";
  const url = new URL(baseUrl);
  if (url.hostname !== orgId && !url.hostname.startsWith(`${orgId}.`)) {
    url.hostname = `${orgId}.${url.hostname}`;
  }
  return url.toString();
}

function requiredOrgId(orgId: string | undefined): string {
  const resolved = orgId ?? env("TILDE_ORG_ID");
  if (!resolved || resolved.trim().length === 0) {
    throw new TypeError("orgId is required");
  }
  return resolved.trim();
}

function requiredTeamId(teamId: string | undefined): string {
  const resolved = teamId ?? env("TILDE_TEAM_ID");
  if (!resolved || resolved.trim().length === 0) {
    throw new TypeError("teamId is required");
  }
  return resolved.trim();
}

function absoluteUrl(baseUrl: string, path: string): string {
  return new URL(path, `${trimTrailingSlash(baseUrl)}/`).toString();
}

function ensureLeadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function normalizePathSegment(value: string | undefined): string {
  return value?.replace(/^\/+|\/+$/g, "") ?? "";
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function env(name: string): string | undefined {
  if (typeof process === "undefined") {
    return undefined;
  }
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}
