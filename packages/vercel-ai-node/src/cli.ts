#!/usr/bin/env node
import { ensureHarnessAuth } from "./auth";
import { loadDotenvFiles } from "./env";
import type { RunLocalRuntimeTunnelCommandOptions } from "./tunnel";
import { runLocalRuntimeTunnelCommand } from "./tunnel";

type ParsedArgs = {
  commandName: "login" | "tunnel";
  baseUrl?: string;
  orgId?: string;
  teamId?: string;
  cloudflaredPath?: string;
  port?: number;
  useDeviceCode?: boolean;
  command: string[];
};

async function main() {
  loadDotenvFiles();
  const args = parseArgs(process.argv.slice(2));
  if (args.commandName === "login") {
    await runLogin(args);
    return;
  }

  if (args.command.length === 0) {
    throw new Error("Usage: harness-sdk tunnel [-p PORT] -- <command>");
  }

  const baseUrl =
    args.baseUrl ?? env("TILDE_BASE_URL") ?? requiredEnv("TILDE_BASE_API_URL");
  configureLocalDevTls(baseUrl);
  const options: RunLocalRuntimeTunnelCommandOptions = {
    baseUrl,
    teamId: args.teamId ?? process.env.TILDE_TEAM_ID ?? "daniels-workspace",
    command: args.command,
  };
  const bearerToken = env("TILDE_BEARER_TOKEN");
  if (bearerToken) {
    options.bearerToken = bearerToken;
  }
  if (args.useDeviceCode) {
    options.useDeviceCode = true;
  }
  const orgId = args.orgId ?? env("TILDE_ORG_ID");
  if (orgId) {
    options.orgId = orgId;
  }
  if (args.cloudflaredPath) {
    options.cloudflaredPath = args.cloudflaredPath;
  }
  if (args.port !== undefined) {
    options.port = args.port;
  }

  const processHandle = await runLocalRuntimeTunnelCommand(options);

  console.log(
    `TILDE_LOCAL_RUNTIME_TUNNEL_ORIGIN=${processHandle.connector.tunnel_origin}`,
  );
  console.log(
    `TILDE_LOCAL_RUNTIME_TUNNEL_DOMAIN=${processHandle.connector.tunnel_domain}`,
  );
  console.log(`TUNNEL_PORT=${processHandle.localPort}`);

  const shutdown = () => processHandle.stop();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function runLogin(args: ParsedArgs): Promise<void> {
  const baseUrl =
    args.baseUrl ?? env("TILDE_BASE_URL") ?? requiredEnv("TILDE_BASE_API_URL");
  configureLocalDevTls(baseUrl);
  const teamId =
    args.teamId ?? process.env.TILDE_TEAM_ID ?? "daniels-workspace";
  const options = {
    baseUrl,
    teamId,
  };
  if (args.useDeviceCode) {
    Object.assign(options, { useDeviceCode: true });
  }
  const orgId = args.orgId ?? env("TILDE_ORG_ID");
  if (orgId) {
    Object.assign(options, { orgId });
  }
  await ensureHarnessAuth(options);
  console.log(`Signed in to ${baseUrl}`);
}

function parseArgs(args: string[]): ParsedArgs {
  if (args[0] !== "tunnel" && args[0] !== "login") {
    throw new Error("Usage: harness-sdk <login|tunnel> [options]");
  }
  const parsed: ParsedArgs = { commandName: args[0], command: [] };

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      parsed.command = args.slice(index + 1);
      return parsed;
    }
    if (arg === "-p" || arg === "--port") {
      parsed.port = parsePort(args[++index], arg);
      continue;
    }
    if (arg === "--base-url") {
      parsed.baseUrl = requiredValue(args[++index], arg);
      continue;
    }
    if (arg === "--team-id") {
      parsed.teamId = requiredValue(args[++index], arg);
      continue;
    }
    if (arg === "--org-id") {
      parsed.orgId = requiredValue(args[++index], arg);
      continue;
    }
    if (arg === "--cloudflared-path") {
      parsed.cloudflaredPath = requiredValue(args[++index], arg);
      continue;
    }
    if (arg === "--use-device-code") {
      parsed.useDeviceCode = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return parsed;
}

function parsePort(value: string | undefined, option: string): number {
  const raw = requiredValue(value, option);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${option} must be a TCP port between 1 and 65535`);
  }
  return port;
}

function requiredValue(value: string | undefined, option: string): string {
  if (!value) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function requiredEnv(name: string): string {
  const value = env(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

function configureLocalDevTls(baseUrl: string): void {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined) {
    return;
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return;
  }
  if (url.protocol !== "https:") {
    return;
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".tilde.test") ||
    hostname === "api.tilde.test"
  ) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
