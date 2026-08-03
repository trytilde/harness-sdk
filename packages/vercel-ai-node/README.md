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
aggregate usage, and closes MCP resources when streaming finishes.

Start, policy-denial, and finish lifecycle records are also emitted as
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
