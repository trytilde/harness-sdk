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

## MCP Server URL

```ts
const server = await tilde.mcp.createServer({
  id: "my-agent-tools",
  name: "My Agent Tools",
  isDynamicToolDiscovery: true
});

console.log(server.url);
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

## Development

```bash
pnpm install
pnpm sdk:refresh
pnpm lint
```

The generated OpenAPI types are internal. Add public APIs through hand-authored wrappers.
