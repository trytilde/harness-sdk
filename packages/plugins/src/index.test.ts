import { describe, expect, test } from "vitest";
import { ensureDesktopAuth } from "./auth";
import {
  cliMcpConfigPath,
  cliSkillInstallDir,
  configureTildeSessionForCli,
  downloadSkillRegistry,
  installSkillRegistriesForCli,
  listTildeTeamChoices,
  listTildeMcpServerChoices,
  listTildeSkillRegistryChoices,
  mcpConfigDocumentForCli,
  mcpServerConfigForCli,
  writeMcpConfigForCli,
} from "./index";
import {
  defaultCommandForCli,
  inferCliFromExecutable,
  parseCliArgs,
} from "./cli";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Tilde plugin helpers", () => {
  test("renders team/name labels for MCP servers and registries", async () => {
    const fetch = async (url: URL | RequestInfo) => {
      const path = url.toString();
      if (path.includes("/mcp/mcp-server")) {
        return json({ items: [{ id: "server-a", name: "Default MCP", url: "https://mcp.test" }] });
      }
      return json({ items: [{ id: "registry-a", name: "Default Skills", description: "Core" }] });
    };
    const config = { baseUrl: "https://api.test", teamId: "team-a", fetch };
    await expect(listTildeMcpServerChoices(config, { teamName: "Platform" })).resolves.toMatchObject([
      { label: "Platform / Default MCP" },
    ]);
    await expect(listTildeSkillRegistryChoices(config, { teamName: "Platform" })).resolves.toMatchObject([
      { label: "Platform / Default Skills" },
    ]);
  });

  test("discovers teams from whoami and lists resources across each team", async () => {
    const seen: string[] = [];
    const fetch = async (url: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer access-token" });
      const path = url.toString();
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
        return json({ items: [{ id: "server-a", name: "Main", url: "https://mcp-a.test" }] });
      }
      if (path.includes("/team/team-b/mcp/mcp-server")) {
        return json({ items: [{ id: "server-b", name: "Labs", url: "https://mcp-b.test" }] });
      }
      if (path.includes("/team/team-a/skill-registry")) {
        return json({ items: [{ id: "registry-a", name: "Core Skills" }] });
      }
      if (path.includes("/team/team-b/skill-registry")) {
        return json({ items: [{ id: "registry-b", name: "Research Skills" }] });
      }
      throw new Error(`Unexpected request ${path}`);
    };
    const config = { baseUrl: "https://api.test", accessToken: "access-token", fetch };

    await expect(listTildeTeamChoices(config)).resolves.toMatchObject([
      { teamId: "team-a", teamName: "Platform", orgId: "org-a" },
      { teamId: "team-b", teamName: "Research", orgId: "org-a" },
    ]);
    await expect(listTildeMcpServerChoices(config)).resolves.toMatchObject([
      { id: "server-a", teamId: "team-a", label: "Platform / Main" },
      { id: "server-b", teamId: "team-b", label: "Research / Labs" },
    ]);
    await expect(listTildeSkillRegistryChoices(config)).resolves.toMatchObject([
      { id: "registry-a", teamId: "team-a", label: "Platform / Core Skills" },
      { id: "registry-b", teamId: "team-b", label: "Research / Research Skills" },
    ]);
    expect(seen).toEqual(expect.arrayContaining([
      "https://api.test/api/v1/team/team-a/mcp/mcp-server?page_size=100",
      "https://api.test/api/v1/team/team-b/mcp/mcp-server?page_size=100",
      "https://api.test/api/v1/team/team-a/skill-registry?page_size=100",
      "https://api.test/api/v1/team/team-b/skill-registry?page_size=100",
    ]));
  });

  test("writes registry skills as SKILL.md files", async () => {
    const fetch = async (url: URL | RequestInfo) => {
      const path = url.toString();
      if (path.includes("/skill-summary")) {
        return json({ items: [{ id: "skill-a", name: "creating-useful-skill" }] });
      }
      expect(path).toContain("/skill-registry/registry-a/skill/skill-a");
      return json({
        name: "creating-useful-skill",
        description: "Creates useful skills",
        content: "# Creating Useful Skills\n\nKeep it concise.",
      });
    };
    const outputDir = await mkdtemp(join(tmpdir(), "tilde-skills-"));
    const written = await downloadSkillRegistry({
      baseUrl: "https://api.test",
      teamId: "team-a",
      fetch,
    }, { registryId: "registry-a", outputDir });
    expect(written).toHaveLength(1);
    const [path] = written;
    expect(path).toBeDefined();
    await expect(readFile(path!, "utf8")).resolves.toContain("name: creating-useful-skill");
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
    expect(mcpConfigDocumentForCli("claude", [server])).toHaveProperty("mcpServers");
    expect(mcpConfigDocumentForCli("codex", [server])).toHaveProperty("mcp_servers");
    expect(mcpConfigDocumentForCli("cursor", [server])).toHaveProperty("mcpServers");
    expect(mcpConfigDocumentForCli("opencode", [server])).toHaveProperty("mcp");
    expect(mcpConfigDocumentForCli("gemini", [server])).toHaveProperty("mcpServers");
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
    await expect(readFile(configPath, "utf8")).resolves.toContain("Platform / Main");

    const fetch = async (url: URL | RequestInfo) => {
      const path = url.toString();
      if (path.includes("/skill-summary")) {
        return json({ items: [{ id: "skill-a", name: "creating-useful-skill" }] });
      }
      return json({
        name: "creating-useful-skill",
        description: "Creates useful skills",
        content: "# Body",
      });
    };
    const files = await installSkillRegistriesForCli("claude", {
      baseUrl: "https://api.test",
      teamId: "team-a",
      fetch,
    }, {
      homeDir,
      registries: [{
        id: "registry-a",
        label: "Platform / Skills",
        teamId: "team-a",
        teamName: "Platform",
        registryName: "Skills",
      }],
    });
    expect(files[0]).toContain(cliSkillInstallDir("claude", homeDir));
  });

  test.each(["claude", "codex", "cursor", "opencode", "gemini"] as const)(
    "configures a non-interactive session for %s",
    async (cli) => {
      const homeDir = await mkdtemp(join(tmpdir(), `tilde-plugin-session-${cli}-`));
      const fetch = async (url: URL | RequestInfo) => {
        const path = url.toString();
        if (path.includes("/mcp/mcp-server")) {
          return json({ items: [{ id: "server-a", name: "Main", url: "https://mcp.test" }] });
        }
        if (path.includes("/skill-registry?")) {
          return json({ items: [{ id: "registry-a", name: "Skills" }] });
        }
        if (path.includes("/skill-summary")) {
          return json({ items: [{ id: "skill-a", name: "creating-useful-skill" }] });
        }
        return json({
          name: "creating-useful-skill",
          description: "Creates useful skills",
          content: "# Body",
        });
      };
      const result = await configureTildeSessionForCli(cli, {
        baseUrl: "https://api.test",
        teamId: "team-a",
        fetch,
      }, {
        homeDir,
        teamName: "Platform",
        interactive: false,
      });
      expect(result.mcpConfigPath).toBe(cliMcpConfigPath(cli, homeDir));
      expect(result.skillFiles).toHaveLength(1);
      await expect(readFile(result.mcpConfigPath, "utf8")).resolves.toContain("Platform / Main");
      expect(result.skillFiles[0]).toContain(cliSkillInstallDir(cli, homeDir));
    },
  );

  test("refreshes stored desktop auth tokens in non-interactive mode", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "tilde-plugin-auth-"));
    const storeDir = join(homeDir, ".tilde", "harness-plugins");
    await mkdir(storeDir, { recursive: true });
    await writeFile(join(storeDir, "auth.json"), JSON.stringify({
      tokens: {
        "https://api.test": {
          access_token: "old-token",
          refresh_token: "refresh-token",
        },
      },
    }));

    const fetch = async (url: URL | RequestInfo, init?: RequestInit) => {
      const path = url.toString();
      if (path.includes("/identity/auth/whoami")) {
        expect(init?.headers).toMatchObject({ Authorization: "Bearer old-token" });
        return new Response("expired", { status: 401 });
      }
      if (path.includes("/identity/auth/refresh")) {
        expect(init?.method).toBe("POST");
        return json({ access_token: "new-token", expires_in: 3600 });
      }
      throw new Error(`Unexpected request ${path}`);
    };

    await expect(ensureDesktopAuth({
      baseUrl: "https://api.test",
      homeDir,
      interactive: false,
      fetch,
    })).resolves.toBe("new-token");
    await expect(readFile(join(storeDir, "auth.json"), "utf8")).resolves.toContain("new-token");
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
