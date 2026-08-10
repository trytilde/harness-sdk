# @trytilde/harness-sdk-vercel-ai-node

Server-side Tilde ChatKit, MCP, and custom tool helpers for applications built
with the Vercel AI SDK.

```bash
pnpm add @trytilde/harness-sdk @trytilde/harness-sdk-vercel-ai-node zod
```

## Remote custom tools

`toolEndpoint` returns signed `GET` discovery and `POST` invocation handlers.
It derives the public invocation URL from the incoming request unless you set
`baseUrl` or `endpointPath`.

```ts
import { toolEndpoint } from "@trytilde/harness-sdk-vercel-ai-node";
import { z } from "zod";

export const { GET, POST } = toolEndpoint({
  webhookSigningKey: process.env.TILDE_CUSTOM_TOOL_SIGNING_KEY!,
  provider: {
    name: "Example tools",
    description: "Example remote tools",
    version: "1.0.0"
  },
  tools: [
    {
      id: "greet",
      name: "Greet",
      description: "Greet a person by name.",
      inputSchema: z.object({ name: z.string() }),
      outputSchema: z.object({ greeting: z.string() }),
      async fn({ name }) {
        return { greeting: `Hello, ${name}!` };
      }
    }
  ]
});
```

See the
[code review bot example](https://github.com/trytilde/examples/tree/main/code-review-bot)
for a complete endpoint.
