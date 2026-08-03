# Tilde Harness SDK

TypeScript SDK packages for Tilde Harness APIs.

## Packages

- `@trytilde/harness-sdk`: core client, MCP helpers, ChatKit helpers, and message history.
- `@trytilde/harness-sdk-react`: React provider and ChatKit hooks.
- `@trytilde/harness-sdk-vercel-ai-node`: ChatKit webhook verification and Vercel AI SDK route helpers.
- `@trytilde/harness-sdk-vercel-ai-react`: React helpers for Vercel AI SDK ChatKit UIs.
- `@trytilde/cli`: Tilde terminal CLI, published with `tilde` and `t` binaries.

## Install

```bash
pnpm add @trytilde/harness-sdk @trytilde/harness-sdk-react @trytilde/harness-sdk-vercel-ai-node @trytilde/harness-sdk-vercel-ai-react
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
```

The CLI can also be invoked as `t`. Running `tilde` or `t` with no command checks
auth state and starts sign-in if needed.

## Core Config

```ts
import { createClient, createConfig } from "@trytilde/harness-sdk";

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
import { wrapMcpClientWithLocalTools } from "@trytilde/harness-sdk";

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
import { createClient } from "@trytilde/harness-sdk";
import { createMCPClient } from "@trytilde/harness-sdk-vercel-ai-node";

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
import { chatKitEndpoint } from "@trytilde/harness-sdk-vercel-ai-node";
import { streamText } from "ai";

export const POST = chatKitEndpoint({
  webhookSigningKey: process.env.TILDE_WEBHOOK_SIGNING_KEY!,
  requestTimeoutMs: 285_000,
  async handler(_request, context) {
    const result = streamText({
      model,
      messages: context.messages
    });

    return result.toUIMessageStreamResponse();
  }
});
```

`requestTimeoutMs` is optional. When configured, the handler request aborts on
either the incoming request signal or the configured timeout.

Configured ChatKit agents can use `runAgent(request, context, { model })`. The
runner accepts only webhook-verified runtime context, restores bounded history,
loads skill packages progressively, and connects the assigned MCP server. When
tilde-api resolves an `AgentWorkspace`, the runner enforces its hard-deny,
approval, command, sandbox, and wall-clock policy. In Auto posture it also
screens provenance-labelled shared history before model access and screens
every tool result before returning it to the model. Suspicious content is
quarantined, while unavailable or oversized screens are explicitly labelled as
untrusted and recorded as durable run events. An invoking-actor workspace
also forwards the short-lived Tilde delegation token together with the agent
API key, so MCP authenticates the call as machine-on-behalf-of-human. If the
workspace has no durable-computer ID yet, the first E2B create result is
persisted through the workspace binding endpoint and reused on later turns.
Before that binding exists, existing-sandbox and global enumeration tools are
not exposed; after binding, sandbox creation and global enumeration are hidden
and every supported sandbox ID field is replaced with the signed workspace ID.
Signed workspace memory-bank IDs are also materialized as `memory_search`,
`memory_reflect`, `memory_remember`, and `memory_forget` tools. The runner
performs a bounded recall for the current human request, writes only to the
first (narrowest) configured bank, pairs invoking-actor delegation with the
agent API key, and screens recalled content in Auto posture before prompt
injection.

## React ChatKit Hooks

```tsx
import { TildeProvider, useChatKitSessionEvents } from "@trytilde/harness-sdk-react";

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

## Publishing

The public runtime packages are versioned together and published in dependency
order:

1. `@trytilde/api-client`
2. `@trytilde/harness-sdk`
3. `@trytilde/harness-sdk-vercel-ai-node`

Validate the release tarballs without publishing:

```bash
pnpm build
pnpm release:validate
pnpm release:smoke
pnpm release:publish -- --dry-run
```

The `Publish npm packages` GitHub workflow runs the complete validation suite
and skips package versions that already exist, so a partially completed release
can be retried safely.

The first npm release requires an `NPM_TOKEN` secret because trusted publishing
can only be configured after each package exists. After the first release,
configure each package to trust `trytilde/harness-sdk` and `publish.yml`, then
remove the long-lived token. The workflow already grants the required OIDC
permission.

Package builds use Vite and tests use Vitest. The generated OpenAPI types are internal. Add public APIs through hand-authored wrappers.
