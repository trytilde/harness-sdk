import { describe, expect, it } from "vitest";
import {
  mcpServerUrl,
  reverseProxyPath,
  reverseProxyUrl,
  teamPath,
} from "../src";

describe("Tilde API path helpers", () => {
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
        teamId: "team/a",
        profileId: "gmail",
        path: "users/me/messages",
        query: { q: "is:unread", maxResults: 500, empty: null },
      }),
    ).toBe(
      "https://api.tilde.test/api/v1/team/team%2Fa/reverse-proxy/gmail/users/me/messages?q=is%3Aunread&maxResults=500",
    );
  });
});
