# Tilde Harness SDK

TypeScript SDK packages for Tilde Harness APIs.

## Packages

- `@tilde/harness-sdk`: core client, MCP helpers, ChatKit helpers, and message history.
- `@tilde/harness-sdk-react`: React provider and ChatKit hooks.
- `@tilde/harness-sdk-vercel-ai-node`: ChatKit webhook verification and Vercel AI SDK route helpers.
- `@tilde/harness-sdk-vercel-ai-react`: React helpers for Vercel AI SDK ChatKit UIs.
- `@trytilde/cli`: Tilde terminal CLI, published with `tilde` and `t` binaries.

## Install

```bash
pnpm add @tilde/harness-sdk @tilde/harness-sdk-react @tilde/harness-sdk-vercel-ai-node @tilde/harness-sdk-vercel-ai-react
pnpm add -D @trytilde/cli
```

## CLI

```bash
tilde auth login
tilde auth whoami
tilde auth set-team
tilde state import ./tilde-state.yaml ./tilde-import-output.json
tilde state import ./tilde-state.yaml ./tilde-import-output.json --auto-apply
tilde state export ./tilde-state.yaml
tilde chat-slurper configure
tilde chat-slurper backfill
tilde chat-slurper status
tilde chat-slurper disable
```

The CLI can also be invoked as `t`. Running `tilde` or `t` with no command checks
auth state and starts sign-in if needed.

`tilde chat-slurper configure` detects Codex (including Codex Desktop) and Claude Code,
lets the user select a team memory bank, and installs additive user-level
capture hooks. Live hook events and `tilde chat-slurper backfill` share the same
normalized, idempotent upload protocol. `disable` removes only Tilde-owned hooks
and leaves previously synchronized history searchable. Codex requires users to
review and trust newly installed command hooks through `/hooks` before they run.

Capture covers session start, prompt submission, tool activity, and stop/end
events. Claude Code additionally captures `Task` and `TodoWrite` lifecycle
events. Repeated events for one transcript are durably queued and coalesced.
Each upload contains compact messages/tool calls, prompts, a locally redacted
raw JSONL transcript, and embedded PNG/JPEG/GIF/WebP assets with SHA-256
integrity metadata.

Secret, provider-token, high-entropy, credentialed-URI, and database connection
string redaction is always enabled. Optional redaction is configured in
`~/.config/tilde/chat-slurper.json` (or `TILDE_CHAT_SLURPER_CONFIG_PATH`):

```json
{
  "redaction": {
    "customPatterns": { "internal_ticket": "TICKET-[0-9]+" },
    "pii": { "email": true, "phone": true, "address": true },
    "openaiPrivacyFilter": {
      "enabled": true,
      "command": "opf",
      "timeoutSeconds": 30,
      "categories": ["private_person", "private_email", "private_phone", "private_address", "secret"]
    }
  }
}
```

When the OpenAI Privacy Filter is enabled, a missing, timed-out, or malformed
`opf` process fails closed: no transcript is uploaded.

## Core Config

```ts
import { createClient, createConfig } from "@tilde/harness-sdk";

const tilde = createClient(createConfig({
  orgId: "org-example",
  teamId: "team_123",
  apiKey: process.env.TILDE_API_KEY,
  // Optional. Starts cloudflared for local agents/tools using apiKey.
  tunnel: true,
  // Optional. Defaults to process.env.TILDE_BASE_API_URL or https://api.trytilde.com.
  baseApiUrl: "https://api.trytilde.com"
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

## Vercel AI MCP Client

Use the Vercel AI node package to create an `@ai-sdk/mcp` client with Tilde
MCP URL construction and `x-api-key` authentication. Tools passed in the map are
registered as local tools alongside the remote MCP server tools.

```ts
import { jsonSchema, tool } from "ai";
import { createClient } from "@tilde/harness-sdk";
import { createMCPClient } from "@tilde/harness-sdk-vercel-ai-node";

const client = createClient({
  orgId: process.env.TILDE_ORG_ID!,
  teamId: process.env.TILDE_TEAM_ID!,
  apiKey: process.env.TILDE_API_KEY!
});

const example = tool({
  description: "Return an example result.",
  inputSchema: jsonSchema({
    type: "object",
    properties: {}
  }),
  async execute() {
    return { ok: true };
  }
});

const mcp = await createMCPClient({
  client,
  serverId: "my-agent-tools",
  tools: { example }
});

const tools = await mcp.tools();
```

## Vercel AI Endpoint

```ts
import { chatKitEndpoint } from "@tilde/harness-sdk-vercel-ai-node";
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

## React ChatKit Hooks

```tsx
import { TildeProvider, useChatKitSessionEvents } from "@tilde/harness-sdk-react";

function Events({ sessionId }: { sessionId: string }) {
  const events = useChatKitSessionEvents({ sessionId, pollIntervalMs: 3000 });
  return <pre>{JSON.stringify(events.items, null, 2)}</pre>;
}

export function App() {
  return (
    <TildeProvider config={{ baseUrl, teamId, apiKey }}>
      <Events sessionId="00000000-0000-0000-0000-000000000000" />
    </TildeProvider>
  );
}
```

## Message History

```ts
const history = await tilde.messages.list({
  sessionId: "00000000-0000-0000-0000-000000000000",
  pageSize: 100
});
```

## Examples

- `examples/nextjs-agent`: Next.js agent using Tilde ChatKit signed webhooks, dynamic MCP, and the Vercel AI SDK.

## Development

```bash
pnpm install
pnpm sdk:refresh
pnpm lint
```

Package builds use Vite and tests use Vitest. The generated OpenAPI types are internal. Add public APIs through hand-authored wrappers.
