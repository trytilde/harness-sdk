import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createClient, createConfig } from "@tilde/harness-sdk";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const tilde = createClient(
  createConfig({
    baseUrl: requireEnv("TILDE_BASE_URL"),
    teamId: requireEnv("TILDE_TEAM_ID"),
    apiKey: requireEnv("TILDE_API_KEY"),
  }),
);

export function tildeAiGateway() {
  const profileId = requireEnv("TILDE_AI_GATEWAY_PROFILE_ID");
  const baseURL =
    process.env.TILDE_AI_GATEWAY_BASE_URL ||
    tilde.aiGateway.openAiCompatibleBaseUrl({ profileId });

  return createOpenAICompatible({
    name: "tilde-ai-gateway",
    baseURL,
    apiKey: requireEnv("TILDE_API_KEY"),
  });
}

export function tildeMcpServerUrl(): string {
  return tilde.mcp.getServerUrl({
    id: requireEnv("TILDE_MCP_SERVER_ID"),
  });
}

export function tildeChatKitUiEndpoint(options?: { stream?: boolean }): string {
  return tilde.chatkit.vercelUiEndpoint({
    sessionId: requireEnv("TILDE_CHATKIT_SESSION_ID"),
    inboxId: requireEnv("TILDE_CHATKIT_INBOX_ID"),
    instanceId: requireEnv("TILDE_CHATKIT_INSTANCE_ID"),
    stream: options?.stream,
  });
}
