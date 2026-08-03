# @trytilde/harness-sdk-vercel-ai-node

Server-side Tilde ChatKit and MCP helpers for applications built with the
Vercel AI SDK.

```bash
pnpm add @trytilde/harness-sdk @trytilde/harness-sdk-vercel-ai-node
```

See the
[code review bot example](https://github.com/trytilde/examples/tree/main/code-review-bot)
for a complete endpoint.

## Configured agent runner

`runAgent` executes a ChatKit agent from the runtime binding injected and
signed by the Tilde API. It restores bounded durable history, progressively
exposes the configured skills registry, connects the assigned MCP server with
actor context, applies the approval posture, limits model/tool steps, reports
aggregate usage, and closes MCP resources when streaming finishes. Auto
posture screens provenance-labelled shared history and each tool result with a
bounded classifier before the model can act on that content. Strict posture
requires approval for every tool, while Dangerous posture disables content
screening without bypassing hard-deny, auth, tenant, credential, or audit
boundaries.

When signed workspace context contains memory banks, the runner recalls
relevant durable context before the model turn and exposes scoped search,
reflection, retention, and deletion tools. Read operations span the configured
banks while writes target only the first bank, so broader read scopes cannot be
accidentally selected for persistence. Bank IDs are never accepted from model
input or an unsigned request body.

Start, policy-denial, security-screen, and finish lifecycle records are emitted as
non-transient `data-agent-run` stream chunks. ChatKit persists those structured
parts with the assistant message, while `onEvent` remains available for logs
and metrics.

```ts
import { openai } from "@ai-sdk/openai";
import { createClient } from "@trytilde/harness-sdk";
import {
  chatKitEndpoint,
  runAgent,
} from "@trytilde/harness-sdk-vercel-ai-node";

const client = createClient();

export const POST = chatKitEndpoint({
  client,
  webhookSigningKey: process.env.TILDE_WEBHOOK_SIGNING_KEY!,
  async handler(request, context) {
    return runAgent(request, context, {
      model: (configured) => openai(configured ?? "gpt-5.4"),
      system: "Operate the company carefully.",
    });
  },
});
```

The route does not accept MCP server or skill registry IDs from an unsigned
client body. Register the HTTP agent with a runtime binding in Tilde state or
through the ChatKit agent API.
