#!/usr/bin/env node
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import {
  type AgentCli,
  configureTildeSessionForCli,
} from "./index";
import { ensureDesktopAuth } from "./auth";

type CliOptions = {
  cli?: AgentCli;
  baseUrl: string;
  teamId?: string;
  teamName?: string;
  apiKey?: string;
  homeDir: string;
  interactive: boolean;
  launch: boolean;
  command?: string;
  passthrough: string[];
};

const supportedClis = new Set<AgentCli>(["claude", "codex", "cursor", "opencode", "gemini"]);

export function inferCliFromExecutable(executable: string): AgentCli | undefined {
  const name = basename(executable).replace(/\.(cjs|mjs|js|cmd|exe)$/i, "");
  const inferred = name.startsWith("tilde-") ? name.slice("tilde-".length) : undefined;
  return inferred && supportedClis.has(inferred as AgentCli) ? (inferred as AgentCli) : undefined;
}

export function defaultCommandForCli(cli: AgentCli): string {
  return cli;
}

export function parseCliArgs(argv: string[], executable = argv[1] ?? "tilde-session"): CliOptions {
  const inferredCli = inferCliFromExecutable(executable);
  const options: CliOptions = {
    baseUrl: process.env.TILDE_API_BASE_URL ?? "https://api.tilde.test",
    homeDir: process.env.TILDE_AGENT_HOME ?? homedir(),
    interactive: process.env.CI !== "true",
    launch: inferredCli !== undefined,
    passthrough: [],
  };
  if (inferredCli) options.cli = inferredCli;
  if (process.env.TILDE_TEAM_ID) options.teamId = process.env.TILDE_TEAM_ID;
  if (process.env.TILDE_TEAM_NAME) options.teamName = process.env.TILDE_TEAM_NAME;
  if (process.env.TILDE_API_KEY) options.apiKey = process.env.TILDE_API_KEY;

  const args = argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      options.passthrough = args.slice(index + 1);
      break;
    }
    switch (arg) {
      case "--cli":
        options.cli = parseCliValue(args[++index]);
        break;
      case "--base-url":
        options.baseUrl = requiredValue(args[++index], "--base-url");
        break;
      case "--team-id":
        options.teamId = requiredValue(args[++index], "--team-id");
        break;
      case "--team-name":
        options.teamName = requiredValue(args[++index], "--team-name");
        break;
      case "--api-key":
        options.apiKey = requiredValue(args[++index], "--api-key");
        break;
      case "--home-dir":
        options.homeDir = requiredValue(args[++index], "--home-dir");
        break;
      case "--command":
        options.command = requiredValue(args[++index], "--command");
        options.launch = true;
        break;
      case "--interactive":
        options.interactive = true;
        break;
      case "--non-interactive":
        options.interactive = false;
        break;
      case "--launch":
        options.launch = true;
        break;
      case "--no-launch":
        options.launch = false;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function main() {
  const options = parseCliArgs(process.argv);
  if (!options.cli) {
    throw new Error("Missing --cli. Expected one of: claude, codex, cursor, opencode, gemini.");
  }
  const accessToken = options.apiKey
    ? undefined
    : await ensureDesktopAuth({
        baseUrl: options.baseUrl,
        homeDir: options.homeDir,
        interactive: options.interactive,
      });

  const result = await configureTildeSessionForCli(
    options.cli,
    {
      baseUrl: options.baseUrl,
      ...(options.teamId ? { teamId: options.teamId } : {}),
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(accessToken ? { accessToken } : {}),
    },
    {
      homeDir: options.homeDir,
      ...(options.teamName ? { teamName: options.teamName } : {}),
      interactive: options.interactive,
    },
  );

  process.stderr.write(
    `Tilde session configured for ${options.cli}\nMCP config: ${result.mcpConfigPath}\nMCP servers enabled: ${result.mcpServerCount}\nSkills installed: ${result.skillFiles.length}\n`,
  );

  if (!options.launch) return;
  const command = options.command ?? defaultCommandForCli(options.cli);
  await runCommand(command, options.passthrough);
}

function parseCliValue(value: string | undefined): AgentCli {
  const required = requiredValue(value, "--cli");
  if (!supportedClis.has(required as AgentCli)) {
    throw new Error(`Unsupported CLI: ${required}`);
  }
  return required as AgentCli;
}

function requiredValue(value: string | undefined, flag: string): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function runCommand(command: string, args: string[]): Promise<never> {
  return new Promise((_resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 0);
    });
  });
}

function printHelp() {
  process.stdout.write(`Usage:
  tilde-session --cli <claude|codex|cursor|opencode|gemini> [options]
  tilde-codex [options] -- <codex args>
  tilde-claude [options] -- <claude args>

Options:
  --base-url <url>       Tilde API base URL. Default: TILDE_API_BASE_URL or https://api.tilde.test
  --team-id <id>         Optional team filter. Default: discover all teams from whoami
  --team-name <name>     Display name used in selector labels. Default: TILDE_TEAM_NAME or team ID
  --api-key <key>        API key sent as Authorization: Bearer. Default: TILDE_API_KEY
  --home-dir <path>      Destination home directory. Default: TILDE_AGENT_HOME or OS home
  --interactive          Show checkbox selectors
  --non-interactive      Select all resources without prompting
  --launch               Launch the underlying CLI after configuration
  --no-launch            Configure only
  --command <command>    Override command launched by wrapper mode
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
