# Tilde Harness SDK

TypeScript SDK packages for Tilde Harness APIs.

## Packages

- `@tilde/harness-sdk`: core client, MCP helpers, ChatKit helpers, and message history.
- `@tilde/harness-sdk-vercel`: ChatKit webhook verification and Vercel AI SDK endpoint helper.

## Install

```bash
pnpm add @tilde/harness-sdk @tilde/harness-sdk-vercel
```

## Core Config

```ts
import { createClient, createConfig } from "@tilde/harness-sdk";

const tilde = createClient(createConfig({
  baseUrl: "https://org-example.api.trytilde.com",
  teamId: "team_123",
  apiKey: process.env.TILDE_API_KEY
}));
```

## AI Gateway

```ts
const profile = await tilde.aiGateway.createProfile({
  id: "openai-prod",
  providerId: "openai",
  resourceServerCredentialId: "00000000-0000-0000-0000-000000000000",
  kind: "chat",
  model: "gpt-5-mini"
});

console.log(tilde.aiGateway.openAiCompatibleBaseUrl({ profileId: profile.id }));
```

## MCP Server URL

```ts
const server = await tilde.mcp.createServer({
  id: "my-agent-tools",
  name: "My Agent Tools",
  isDynamicToolDiscovery: true
});

console.log(server.url);

await tilde.mcp.addFunction({
  serverId: server.id,
  toolSourceTypeId: "tool-source-type",
  toolGroupSourceTypeId: "tool-group-source-type",
  toolGroupInstanceId: "tool-group-instance-id",
  toolName: "tool-name"
});
```

`client.mcp.getServerUrl({ id })` returns the raw Streamable HTTP MCP URL for AI SDK clients and other MCP-capable runtimes.

## MCP Local Tools

Wrap an existing MCP client to add process-local tools. Local tools are exposed
alongside remote MCP tools, execute in-process, and are split out of
`MULTI_EXECUTE_TOOL` calls automatically.

```ts
import { createMCPClient } from "@ai-sdk/mcp";
import { wrapMcpClientWithLocalTools } from "@tilde/harness-sdk";

const mcp = await createMCPClient({
  transport: {
    type: "http",
    url: tilde.mcp.getServerUrl({ id: "my-agent-tools" })
  }
});

const wrappedMcp = wrapMcpClientWithLocalTools({
  client: mcp,
  serverId: "my-agent-tools",
  tools: [
    {
      name: "LOCAL_GET_USER_CONTEXT",
      description: "Return app-local user context.",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        return { plan: "pro" };
      }
    }
  ]
});

const tools = await wrappedMcp.tools();
```

## Vercel AI Endpoint

```ts
import { chatKitEndpoint } from "@tilde/harness-sdk-vercel";
import { streamText } from "ai";

export const POST = chatKitEndpoint({
  webhookSigningKey: process.env.TILDE_WEBHOOK_SIGNING_KEY!,
  async handler(request) {
    const body = await request.json();

    const result = streamText({
      model,
      messages: body.messages
    });

    return result.toUIMessageStreamResponse();
  }
});
```

## Message History

```ts
const history = await tilde.messages.list({
  sessionId: "00000000-0000-0000-0000-000000000000",
  pageSize: 100
});
```

## Examples

- `examples/nextjs-agent`: Next.js agent using Tilde AI gateway, ChatKit signed webhooks, dynamic MCP, and the Vercel AI SDK.

## Development

```bash
pnpm install
pnpm sdk:refresh
pnpm lint
```

The generated OpenAPI types are internal. Add public APIs through hand-authored wrappers.
