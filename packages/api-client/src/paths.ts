export type TeamPathInput = {
  teamId: string;
};

export type ReverseProxyUrlInput = TeamPathInput & {
  baseUrl: string;
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
  return `/api/v1/team/${encodeURIComponent(input.teamId)}${ensureLeadingSlash(path)}`;
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
    `${trimTrailingSlash(input.baseUrl)}/`,
  );
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
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
