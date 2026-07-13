# Tilde Next.js Agent Example

This example shows a Next.js agent that uses:

- Tilde dynamic MCP through `@ai-sdk/mcp`.
- Tilde ChatKit inbound webhooks through `@tilde/harness-sdk-vercel-ai-node`.
- A caller-configured OpenAI-compatible model provider through the Vercel AI SDK.

## Setup

```bash
pnpm -C ../.. build
pnpm install
cp .env.example .env.local
pnpm tunnel
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

Set `TILDE_MCP_SERVER_ID` to that server id. Set `MODEL_BASE_URL`,
`MODEL_API_KEY`, and `MODEL_NAME` for your OpenAI-compatible model provider.

ChatKit should call `/chatkit/agents` with Tilde webhook signing headers. The
same signed handler is also mounted at `/api/chatkit` for framework-style
deployments. ChatKit route handlers receive a typed `context.session` client;
call `context.session.history()` to load paginated historical messages for the
signed session.

Use `pnpm tunnel` for local ChatKit testing. It runs:

```bash
tilde tunnel -- next dev --webpack -p '$TUNNEL_PORT'
```

The tunnel runner starts Cloudflare tunnel connectivity, picks a local app port
starting at `3000` unless `-p` is supplied, sets `PORT` and `TUNNEL_PORT`, and
proxies the managed Cloudflare ingress port to the spawned app process.
