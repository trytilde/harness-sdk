import { afterEach, describe, expect, it } from "vitest";
import {
  mcpServerUrl,
  reverseProxyPath,
  reverseProxyUrl,
  teamPath,
} from "../src";

describe("Tilde API path helpers", () => {
  afterEach(() => {
    delete process.env.TILDE_ORG_ID;
    delete process.env.TILDE_TEAM_ID;
    delete process.env.TILDE_BASE_URL;
  });

  it("builds team-scoped paths with encoded team ids", () => {
    expect(teamPath({ teamId: "team/a" }, "/mcp/mcp-server")).toBe(
      "/api/v1/team/team%2Fa/mcp/mcp-server",
    );
  });

  it("builds MCP server URLs", () => {
    expect(
      mcpServerUrl({
        baseUrl: "https://api.tilde.test/",
        teamId: "team/a",
        serverId: "server/b",
      }),
    ).toBe(
      "https://api.tilde.test/api/v1/team/team%2Fa/mcp/mcp-server/server%2Fb/mcp",
    );
  });

  it("builds reverse proxy paths and URLs", () => {
    expect(
      reverseProxyPath({
        teamId: "team/a",
        profileId: "gmail/profile",
        pathPrefix: "/gmail/v1/",
        path: "/users/me/messages",
      }),
    ).toBe(
      "/api/v1/team/team%2Fa/reverse-proxy/gmail%2Fprofile/gmail/v1/users/me/messages",
    );
    expect(
      reverseProxyUrl({
        baseUrl: "https://api.tilde.test",
        orgId: "daniels-workspace",
        teamId: "team/a",
        profileId: "gmail",
        path: "users/me/messages",
        query: { q: "is:unread", maxResults: 500, empty: null },
      }),
    ).toBe(
      "https://daniels-workspace.api.tilde.test/api/v1/team/team%2Fa/reverse-proxy/gmail/users/me/messages?q=is%3Aunread&maxResults=500",
    );
  });

  it("builds reverse proxy URLs from environment org and team ids", () => {
    process.env.TILDE_ORG_ID = "daniels-workspace";
    process.env.TILDE_TEAM_ID = "team_env";
    process.env.TILDE_BASE_URL = "https://api.tilde.test";

    expect(
      reverseProxyUrl({
        profileId: "gmail",
        path: "users/me/messages",
      }),
    ).toBe(
      "https://daniels-workspace.api.tilde.test/api/v1/team/team_env/reverse-proxy/gmail/users/me/messages",
    );
  });
});
