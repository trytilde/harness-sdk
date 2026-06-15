import { type Client, createClient } from "@tilde/harness-sdk";

export type E2EEnv = {
  baseUrl?: string;
  baseApiUrl?: string;
  orgId?: string;
  teamId: string;
  apiKey: string;
};

export function readE2EEnv(): E2EEnv {
  if (process.env.TILDE_E2E !== "1") {
    throw new Error("Set TILDE_E2E=1 to run SDK e2e tests");
  }

  const teamId = requiredEnv("TILDE_E2E_TEAM_ID");
  const apiKey = requiredEnv("TILDE_E2E_API_KEY");
  const baseUrl = optionalEnv("TILDE_E2E_BASE_URL");
  const orgId = optionalEnv("TILDE_E2E_ORG_ID");
  const baseApiUrl =
    optionalEnv("TILDE_E2E_BASE_API_URL") ?? optionalEnv("TILDE_BASE_API_URL");

  if (!baseUrl && !orgId) {
    throw new Error("Set TILDE_E2E_BASE_URL or TILDE_E2E_ORG_ID");
  }

  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(baseApiUrl ? { baseApiUrl } : {}),
    ...(orgId ? { orgId } : {}),
    teamId,
    apiKey,
  };
}

export function createE2EClient(): Client {
  const env = readE2EEnv();
  return createClient({
    ...env,
    headers: {
      "x-api-key": env.apiKey,
      Authorization: "",
    },
  });
}

function requiredEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) {
    throw new Error(`${name} is required for SDK e2e tests`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}
