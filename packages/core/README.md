# @trytilde/harness-sdk

Core TypeScript client for Tilde agents, MCP servers, skills, ChatKit sessions,
and credential-injecting reverse proxies.

```bash
pnpm add @trytilde/harness-sdk
```

See the
[code review bot example](https://github.com/trytilde/examples/tree/main/code-review-bot)
for a complete Next.js, ChatKit, MCP, and reverse-proxy integration.

## Materialize a managed skill package

Managed skills may include scripts, references, templates, and assets in
addition to `SKILL.md`. The SDK reads the manifest first and lazily requests a
short-lived R2 URL for each file. `materialize` verifies file sizes and SHA-256
checksums, preserves executable bits, and atomically moves the completed tree
into the requested directory.

```ts
import { createClient } from "@trytilde/harness-sdk";

const tilde = createClient();
const skill = await tilde.skills.registry(registryId).then((registry) =>
  registry.find("popular-web-designs"),
);

await tilde.skills
  .package(skill.id)
  .materialize("/workspace/.agents/skills/popular-web-designs");
```

`materialize` is a Node.js API and is suitable for a scoped Modal computer or
another agent filesystem. Browser callers can use `manifest()` and
`download(path)` directly.
