# Tilde Next.js Agent Example

This example shows a Next.js agent that uses:

- Tilde AI gateway through an OpenAI-compatible Vercel AI SDK provider.
- Tilde dynamic MCP through `@ai-sdk/mcp`.
- Tilde ChatKit inbound webhooks through `@tilde/harness-sdk-vercel`.

## Setup

```bash
pnpm -C ../.. build
pnpm install
cp .env.example .env.local
pnpm dev
```

Before running the app, create or reuse:

```ts
import { createClient, createConfig } from "@tilde/harness-sdk";

const tilde = createClient(createConfig({
  baseUrl: process.env.TILDE_BASE_URL!,
  teamId: process.env.TILDE_TEAM_ID!,
  apiKey: process.env.TILDE_API_KEY!
}));

const server = await tilde.mcp.createServer({
  id: "my-agent-tools",
  name: "My Agent Tools",
  isDynamicToolDiscovery: true
});

await tilde.mcp.addFunction({
  serverId: server.id,
  toolSourceTypeId: "tool-source-type",
  toolGroupSourceTypeId: "tool-group-source-type",
  toolGroupInstanceId: "tool-group-instance-id",
  toolName: "tool-name"
});
```

Set `TILDE_MCP_SERVER_ID` to that server id. Set `TILDE_AI_GATEWAY_PROFILE_ID`
to a chat profile configured in the Tilde AI gateway. If your deployment exposes
the credential proxy at a custom public URL, set `TILDE_AI_GATEWAY_BASE_URL`;
otherwise the example derives the conventional profile proxy URL from the SDK.

Browser chat posts to `/api/chat`. ChatKit should call `/api/chatkit` with
Tilde webhook signing headers.
