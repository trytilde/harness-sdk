import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ensureDesktopAuth } from "./auth";
import {
  defaultCommandForCli,
  inferCliFromExecutable,
  parseCliArgs,
} from "./cli";
import {
  cliMcpConfigPath,
  cliSkillInstallDir,
  configureTildeSessionForCli,
  downloadSkillRegistry,
  installSkillRegistriesForCli,
  listTildeMcpServerChoices,
  listTildeSkillRegistryChoices,
  listTildeTeamChoices,
  mcpConfigDocumentForCli,
  mcpServerConfigForCli,
  writeMcpConfigForCli,
} from "./index";

function requestUrl(input: URL | RequestInfo): string {
  return input instanceof Request ? input.url : input.toString();
}

function requestHeaders(input: URL | RequestInfo, init?: RequestInit): Headers {
  return new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
}

function requestMethod(input: URL | RequestInfo, init?: RequestInit): string {
  return init?.method ?? (input instanceof Request ? input.method : "GET");
}

async function requestBodyText(
  input: URL | RequestInfo,
  init?: RequestInit,
): Promise<string> {
  if (typeof init?.body === "string") {
    return init.body;
  }
  if (init?.body instanceof URLSearchParams) {
    return init.body.toString();
  }
  if (init?.body !== undefined && init.body !== null) {
    return String(init.body);
  }
  if (input instanceof Request) {
    return input.clone().text();
  }
  return "";
}

async function requestJsonBody<T>(
  input: URL | RequestInfo,
  init?: RequestInit,
): Promise<T> {
  return JSON.parse(await requestBodyText(input, init)) as T;
}

describe("Tilde plugin helpers", () => {
  test("renders team/name labels for MCP servers and registries", async () => {
    const fetch = async (url: URL | RequestInfo) => {
      const path = requestUrl(url);
      if (path.includes("/mcp/mcp-server")) {
        return json({
          items: [
            { id: "server-a", name: "Default MCP", url: "https://mcp.test" },
          ],
        });
      }
      return json({
        items: [
          { id: "registry-a", name: "Default Skills", description: "Core" },
        ],
      });
    };
    const config = { baseUrl: "https://api.test", teamId: "team-a", fetch };
    await expect(
      listTildeMcpServerChoices(config, { teamName: "Platform" }),
    ).resolves.toMatchObject([{ label: "Platform / Default MCP" }]);
    await expect(
      listTildeSkillRegistryChoices(config, { teamName: "Platform" }),
    ).resolves.toMatchObject([{ label: "Platform / Default Skills" }]);
  });

  test("discovers teams from whoami and lists resources across each team", async () => {
    const seen: string[] = [];
    const fetch = async (url: URL | RequestInfo, init?: RequestInit) => {
      expect(requestHeaders(url, init).get("Authorization")).toBe(
        "Bearer access-token",
      );
      const path = requestUrl(url);
      seen.push(path);
      if (path.includes("/identity/auth/whoami")) {
        return json({
          teams: [
            { team_id: "team-a", name: "Platform", org_id: "org-a" },
            { team_id: "team-b", name: "Research", org_id: "org-a" },
          ],
        });
      }
      if (path.includes("/team/team-a/mcp/mcp-server")) {
        return json({ items: [{ id: "server-a", name: "Main" }] });
      }
      if (path.includes("/team/team-b/mcp/mcp-server")) {
        return json({ items: [{ id: "server-b", name: "Labs" }] });
      }
      if (path.includes("/team/team-a/skill-registry")) {
        return json({ items: [{ id: "registry-a", name: "Core Skills" }] });
      }
      if (path.includes("/team/team-b/skill-registry")) {
        return json({ items: [{ id: "registry-b", name: "Research Skills" }] });
      }
      throw new Error(`Unexpected request ${path}`);
    };
    const config = {
      baseUrl: "https://api.test",
      accessToken: "access-token",
      fetch,
    };

    await expect(listTildeTeamChoices(config)).resolves.toMatchObject([
      { teamId: "team-a", teamName: "Platform", orgId: "org-a" },
      { teamId: "team-b", teamName: "Research", orgId: "org-a" },
    ]);
    await expect(listTildeMcpServerChoices(config)).resolves.toMatchObject([
      {
        id: "server-a",
        teamId: "team-a",
        label: "Platform / Main",
        url: "https://api.test/api/v1/team/team-a/mcp/mcp-server/server-a/mcp",
      },
      {
        id: "server-b",
        teamId: "team-b",
        label: "Research / Labs",
        url: "https://api.test/api/v1/team/team-b/mcp/mcp-server/server-b/mcp",
      },
    ]);
    await expect(listTildeSkillRegistryChoices(config)).resolves.toMatchObject([
      { id: "registry-a", teamId: "team-a", label: "Platform / Core Skills" },
      {
        id: "registry-b",
        teamId: "team-b",
        label: "Research / Research Skills",
      },
    ]);
    expect(seen).toEqual(
      expect.arrayContaining([
        "https://api.test/api/v1/team/team-a/mcp/mcp-server?page_size=100",
        "https://api.test/api/v1/team/team-b/mcp/mcp-server?page_size=100",
        "https://api.test/api/v1/team/team-a/skill-registry?page_size=100",
        "https://api.test/api/v1/team/team-b/skill-registry?page_size=100",
      ]),
    );
  });

  test("writes registry skills as SKILL.md files", async () => {
    const fetch = async (url: URL | RequestInfo) => {
      const path = requestUrl(url);
      if (path.includes("/skill-summary")) {
        return json({
          items: [{ id: "skill-a", name: "creating-useful-skill" }],
        });
      }
      expect(path).toContain("/skill-registry/registry-a/skill/skill-a");
      return json({
        name: "creating-useful-skill",
        description: "Creates useful skills",
        content: "# Creating Useful Skills\n\nKeep it concise.",
      });
    };
    const outputDir = await mkdtemp(join(tmpdir(), "tilde-skills-"));
    const written = await downloadSkillRegistry(
      {
        baseUrl: "https://api.test",
        teamId: "team-a",
        fetch,
      },
      { registryId: "registry-a", outputDir },
    );
    expect(written).toHaveLength(1);
    const [path] = written;
    if (!path) {
      throw new Error("Expected downloadSkillRegistry to write one file");
    }
    await expect(readFile(path, "utf8")).resolves.toContain(
      "name: creating-useful-skill",
    );
  });

  test("creates MCP config documents for supported CLIs", () => {
    const server = {
      id: "server-a",
      label: "Team / Server",
      teamId: "team-a",
      teamName: "Team",
      serverName: "Server",
      url: "https://mcp.test",
    };
    expect(mcpServerConfigForCli("codex", server)).toMatchObject({
      transport: "streamable_http",
      url: "https://mcp.test",
    });
    expect(mcpConfigDocumentForCli("claude", [server])).toHaveProperty(
      "mcpServers",
    );
    expect(mcpConfigDocumentForCli("codex", [server])).toHaveProperty(
      "mcp_servers",
    );
    expect(mcpConfigDocumentForCli("cursor", [server])).toHaveProperty(
      "mcpServers",
    );
    expect(mcpConfigDocumentForCli("opencode", [server])).toHaveProperty("mcp");
    expect(mcpConfigDocumentForCli("gemini", [server])).toHaveProperty(
      "mcpServers",
    );
  });

  test("writes CLI config and installs registries atomically", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "tilde-plugin-home-"));
    const server = {
      id: "server-a",
      label: "Platform / Main",
      teamId: "team-a",
      teamName: "Platform",
      serverName: "Main",
      url: "https://mcp.test",
    };
    const configPath = await writeMcpConfigForCli("claude", {
      homeDir,
      servers: [server],
    });
    expect(configPath).toBe(cliMcpConfigPath("claude", homeDir));
    await expect(readFile(configPath, "utf8")).resolves.toContain(
      "Platform / Main",
    );

    const fetch = async (url: URL | RequestInfo) => {
      const path = requestUrl(url);
      if (path.includes("/skill-summary")) {
        return json({
          items: [{ id: "skill-a", name: "creating-useful-skill" }],
        });
      }
      return json({
        name: "creating-useful-skill",
        description: "Creates useful skills",
        content: "# Body",
      });
    };
    const files = await installSkillRegistriesForCli(
      "claude",
      {
        baseUrl: "https://api.test",
        teamId: "team-a",
        fetch,
      },
      {
        homeDir,
        registries: [
          {
            id: "registry-a",
            label: "Platform / Skills",
            teamId: "team-a",
            teamName: "Platform",
            registryName: "Skills",
          },
        ],
      },
    );
    expect(files[0]).toContain(cliSkillInstallDir("claude", homeDir));
  });

  test.each([
    "claude",
    "codex",
    "cursor",
    "opencode",
    "gemini",
  ] as const)("configures a non-interactive session for %s", async (cli) => {
    const homeDir = await mkdtemp(
      join(tmpdir(), `tilde-plugin-session-${cli}-`),
    );
    const fetch = async (url: URL | RequestInfo) => {
      const path = requestUrl(url);
      if (path.includes("/mcp/mcp-server")) {
        return json({ items: [{ id: "server-a", name: "Main" }] });
      }
      if (path.includes("/skill-registry?")) {
        return json({ items: [{ id: "registry-a", name: "Skills" }] });
      }
      if (path.includes("/skill-summary")) {
        return json({
          items: [{ id: "skill-a", name: "creating-useful-skill" }],
        });
      }
      return json({
        name: "creating-useful-skill",
        description: "Creates useful skills",
        content: "# Body",
      });
    };
    const result = await configureTildeSessionForCli(
      cli,
      {
        baseUrl: "https://api.test",
        teamId: "team-a",
        fetch,
      },
      {
        homeDir,
        teamName: "Platform",
        interactive: false,
      },
    );
    expect(result.mcpConfigPath).toBe(cliMcpConfigPath(cli, homeDir));
    expect(result.skillFiles).toHaveLength(1);
    const mcpConfig = await readFile(result.mcpConfigPath, "utf8");
    expect(mcpConfig).toContain("Platform / Main");
    expect(mcpConfig).toContain(
      "https://api.test/api/v1/team/team-a/mcp/mcp-server/server-a/mcp",
    );
    expect(result.skillFiles[0]).toContain(cliSkillInstallDir(cli, homeDir));
  });

  test("refreshes stored desktop auth tokens in non-interactive mode", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "tilde-plugin-auth-"));
    const storeDir = join(homeDir, ".tilde", "harness-plugins");
    await mkdir(storeDir, { recursive: true });
    await writeFile(
      join(storeDir, "auth.json"),
      JSON.stringify({
        tokens: {
          "https://api.test": {
            access_token: "old-token",
            refresh_token: "refresh-token",
          },
        },
      }),
    );

    const fetch = async (url: URL | RequestInfo, init?: RequestInit) => {
      const path = requestUrl(url);
      if (path.includes("/identity/auth/whoami")) {
        expect(requestHeaders(url, init).get("Authorization")).toBe(
          "Bearer old-token",
        );
        return new Response("expired", { status: 401 });
      }
      if (path.includes("/identity/auth/refresh")) {
        expect(requestMethod(url, init)).toBe("POST");
        return json({ access_token: "new-token", expires_in: 3600 });
      }
      throw new Error(`Unexpected request ${path}`);
    };

    await expect(
      ensureDesktopAuth({
        baseUrl: "https://api.test",
        homeDir,
        interactive: false,
        fetch,
      }),
    ).resolves.toBe("new-token");
    await expect(
      readFile(join(storeDir, "auth.json"), "utf8"),
    ).resolves.toContain("new-token");
  });

  test("uses dynamic client registration for interactive auth", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "tilde-plugin-desktop-auth-"));
    const opened: string[] = [];
    const originalOpen = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      const text = chunk.toString();
      if (text.startsWith("Opening browser for Tilde auth: ")) {
        opened.push(
          text.slice("Opening browser for Tilde auth: ".length).trim(),
        );
      }
      return true;
    }) as typeof process.stderr.write;
    try {
      const auth = ensureDesktopAuth({
        baseUrl: "https://api.test",
        homeDir,
        interactive: true,
        fetch: async (url: URL | RequestInfo, init?: RequestInit) => {
          const path = requestUrl(url);
          if (path.includes("/identity/auth/whoami")) {
            return new Response("missing", { status: 401 });
          }
          if (path.includes("/identity/oauth/register")) {
            expect(requestMethod(url, init)).toBe("POST");
            const body = await requestJsonBody<{
              resource: string;
              redirect_uris: string[];
            }>(url, init);
            expect(body.resource).toBe("https://api.test/mcp");
            expect(body.redirect_uris[0]).toMatch(
              /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
            );
            return json({ client_id: "tilde-dcr-test-client" });
          }
          if (path.includes("/identity/oauth/token")) {
            const body = new URLSearchParams(await requestBodyText(url, init));
            expect(body.get("client_id")).toBe("tilde-dcr-test-client");
            return json({
              access_token: "desktop-access-token",
              refresh_token: "desktop-refresh-token",
              expires_in: 3600,
            });
          }
          throw new Error(`Unexpected request ${path}`);
        },
      });
      await waitFor(() => opened.length === 1);
      const openedUrl = opened.at(0);
      if (!openedUrl) {
        throw new Error("Expected desktop auth to open an authorization URL");
      }
      const url = new URL(openedUrl);
      expect(url.searchParams.get("client_id")).toBe("tilde-dcr-test-client");
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      if (!redirectUri || !state) {
        throw new Error(
          "Expected desktop auth URL to include redirect_uri and state",
        );
      }
      await fetch(`${redirectUri}?code=test-code&state=${state}`);
      await expect(auth).resolves.toBe("desktop-access-token");
    } finally {
      process.stderr.write = originalOpen;
    }
  });

  test("parses configure-only and wrapper CLI invocations", () => {
    expect(inferCliFromExecutable("/usr/local/bin/tilde-codex")).toBe("codex");
    expect(defaultCommandForCli("claude")).toBe("claude");

    const configureOnly = parseCliArgs([
      "node",
      "tilde-session",
      "--cli",
      "codex",
      "--team-id",
      "team-a",
      "--base-url",
      "https://api.test",
      "--non-interactive",
      "--no-launch",
    ]);
    expect(configureOnly).toMatchObject({
      cli: "codex",
      teamId: "team-a",
      baseUrl: "https://api.test",
      interactive: false,
      launch: false,
    });

    const wrapper = parseCliArgs([
      "node",
      "/usr/local/bin/tilde-claude",
      "--team-id",
      "team-a",
      "--",
      "--dangerously-skip-permissions",
    ]);
    expect(wrapper).toMatchObject({
      cli: "claude",
      teamId: "team-a",
      launch: true,
      passthrough: ["--dangerously-skip-permissions"],
    });
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for predicate");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
