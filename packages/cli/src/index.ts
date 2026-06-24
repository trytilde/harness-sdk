#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  type Config,
  createClient,
  type HostedAgentDeploymentFile,
  type HostedAgentEndpoint,
  type HostedCustomToolEndpoint,
  type TildeAppDefinition,
} from "@tilde/harness-sdk";
import { tsImport } from "tsx/esm/api";

type DeployOptions = {
  configPath: string;
  cwd: string;
  projectSlug?: string;
  baseUrl?: string;
  baseApiUrl?: string;
  orgId?: string;
  teamId?: string;
  apiKey?: string;
  bearerToken?: string;
  dryRun: boolean;
  configureChatkit: boolean;
  invoke: boolean;
};

type DeploymentPayload = {
  projectSlug: string;
  agents: HostedAgentEndpoint[];
  customTools: HostedCustomToolEndpoint[];
  files: HostedAgentDeploymentFile[];
};

type ParsedArgs = {
  command: string;
  rest: string[];
};

const DEFAULT_CONFIG_FILES = [
  "tilde.config.ts",
  "tilde.config.mts",
  "tilde.config.js",
  "tilde.config.mjs",
];

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseCommand(argv);
  if (
    !parsed.command ||
    parsed.command === "help" ||
    parsed.command === "--help"
  ) {
    printHelp();
    return;
  }
  switch (parsed.command) {
    case "deploy":
      await deploy(parseDeployOptions(parsed.rest));
      return;
    case "auth":
      auth(parsed.rest);
      return;
    case "codex":
    case "claude":
      clientPlugin(parsed.command, parsed.rest);
      return;
    default:
      throw new Error(`Unknown command: ${parsed.command}`);
  }
}

function parseCommand(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  return { command, rest };
}

function parseDeployOptions(argv: string[]): DeployOptions {
  const options: DeployOptions = {
    configPath: "",
    cwd: process.cwd(),
    dryRun: false,
    configureChatkit: false,
    invoke: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--config":
        options.configPath = requireValue(argv, ++index, arg);
        break;
      case "--cwd":
        options.cwd = path.resolve(requireValue(argv, ++index, arg));
        break;
      case "--project":
        options.projectSlug = requireValue(argv, ++index, arg);
        break;
      case "--base-url":
        options.baseUrl = requireValue(argv, ++index, arg);
        break;
      case "--base-api-url":
        options.baseApiUrl = requireValue(argv, ++index, arg);
        break;
      case "--org":
        options.orgId = requireValue(argv, ++index, arg);
        break;
      case "--team":
        options.teamId = requireValue(argv, ++index, arg);
        break;
      case "--api-key":
        options.apiKey = requireValue(argv, ++index, arg);
        break;
      case "--bearer-token":
        options.bearerToken = requireValue(argv, ++index, arg);
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--configure-chatkit":
        options.configureChatkit = true;
        break;
      case "--invoke":
        options.configureChatkit = true;
        options.invoke = true;
        break;
      default:
        throw new Error(`Unknown deploy option: ${arg}`);
    }
  }
  return options;
}

async function deploy(options: DeployOptions): Promise<void> {
  const configPath = options.configPath
    ? path.resolve(options.cwd, options.configPath)
    : await findConfig(options.cwd);
  const app = await loadAppDefinition(configPath);
  const projectSlug =
    options.projectSlug ?? app.name ?? path.basename(options.cwd);
  const payload = await createDeploymentPayload(options.cwd, app, projectSlug);

  if (options.dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const teamId = options.teamId ?? process.env.TILDE_TEAM_ID;
  if (!teamId) {
    throw new Error("Missing team id. Pass --team or set TILDE_TEAM_ID.");
  }
  const config = compactConfig(teamId, {
    orgId: options.orgId ?? process.env.TILDE_ORG_ID,
    baseUrl: options.baseUrl ?? process.env.TILDE_BASE_URL,
    baseApiUrl: options.baseApiUrl ?? process.env.TILDE_BASE_API_URL,
    apiKey: options.apiKey ?? process.env.TILDE_API_KEY,
    bearerToken: options.bearerToken ?? process.env.TILDE_BEARER_TOKEN,
  });
  const client = createClient(config);
  let deployment = await client.agents.deployHosted(payload);
  console.log(`Deployed ${projectSlug}`);
  console.log(`Deployment: ${deployment.deploymentUrl}`);
  const deployedCustomTools = deployment.customTools ?? [];
  for (const agent of deployment.agents) {
    console.log(`Agent ${agent.id}: ${deployment.deploymentUrl}${agent.path}`);
  }
  for (const customTool of deployedCustomTools) {
    console.log(
      `Custom tool ${customTool.id}: ${deployment.deploymentUrl}${customTool.path}`,
    );
  }

  const customToolSecrets: Record<string, string> = {};
  let customToolProvider:
    | {
        toolGroupInstanceId: string;
        toolGroupSourceTypeId: string;
      }
    | undefined;
  if (deployedCustomTools.length > 0) {
    const registration = await client.mcp.createCustomToolProvider({
      displayName: `${projectSlug} custom tools`,
      description: `Custom tools deployed from ${projectSlug}`,
      discoveryUrl: `${deployment.deploymentUrl}/api/tilde/tools`,
    });
    customToolProvider = {
      toolGroupInstanceId: registration.toolGroupInstanceId,
      toolGroupSourceTypeId: registration.toolGroupSourceTypeId,
    };
    for (const customTool of deployedCustomTools) {
      customToolSecrets[customTool.id] = registration.signingKey;
    }
    console.log(
      `Registered custom tool provider ${registration.toolGroupInstanceId}`,
    );
  }

  if (
    !options.configureChatkit &&
    Object.keys(customToolSecrets).length === 0
  ) {
    return;
  }

  const secrets: Record<string, AgentRuntimeSecrets> = {};
  let defaultAgentInboxId = "";
  if (options.configureChatkit) {
    for (const agentEndpoint of deployment.agents) {
      const registration = await client.chatkit.registerHttpVercelAiSdkAgent({
        id: `hosted-${agentEndpoint.id}`,
        displayName: agentEndpoint.id,
        endpointUrl: `${deployment.deploymentUrl}${agentEndpoint.path}`,
        streaming: false,
        timeoutMs: 15000,
      });
      const agentId = inboxId(registration.agent);
      defaultAgentInboxId ||= agentId;
      secrets[agentEndpoint.id] = {
        apiKey: registration.apiKey,
        webhookSigningKey: registration.webhookSigningKey,
      };
      console.log(`Registered ChatKit agent ${agentId}`);
    }
  }

  const redeployPayload = await createDeploymentPayload(
    options.cwd,
    app,
    projectSlug,
    secrets,
    customToolSecrets,
  );
  deployment = await client.agents.deployHosted(redeployPayload);
  console.log(`Redeployed ${projectSlug} with runtime secrets`);

  if (options.configureChatkit && defaultAgentInboxId) {
    const channel = await client.chatkit.registerVercelUiChannel({
      id: `${projectSlug}-vercel-ui`,
      displayName: `${projectSlug} Vercel UI`,
      defaultAgentInboxId,
    });
    const channelId = inboxId(channel);
    console.log(`Registered ChatKit Vercel UI channel ${channelId}`);
  }

  if (options.invoke) {
    const agentEndpoint = deployment.agents[0];
    if (agentEndpoint) {
      const response = await invokeHostedAgent({
        endpointUrl: `${deployment.deploymentUrl}${agentEndpoint.path}`,
        secrets: secrets[agentEndpoint.id],
      });
      console.log(`Invocation response: ${response}`);
    }
    const customTool = (deployment.customTools ?? [])[0];
    if (customToolProvider && customTool) {
      const result = await client.mcp.invokeCustomTool({
        toolGroupInstanceId: customToolProvider.toolGroupInstanceId,
        toolSourceTypeId: customTool.id,
        params: { text: "hello" },
      });
      console.log(
        `Custom tool invocation response: ${customToolOutput(result)}`,
      );
    }
  }
}

async function findConfig(cwd: string): Promise<string> {
  for (const file of DEFAULT_CONFIG_FILES) {
    const candidate = path.join(cwd, file);
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // Try the next conventional config path.
    }
  }
  throw new Error(`No Tilde config found in ${cwd}`);
}

async function loadAppDefinition(
  configPath: string,
): Promise<TildeAppDefinition> {
  const mod = (await tsImport(
    pathToFileURL(configPath).toString(),
    import.meta.url,
  )) as { default?: TildeAppDefinition; app?: TildeAppDefinition };
  const app = mod.default ?? mod.app;
  if (!app) {
    throw new Error(`${configPath} must export a default Tilde app definition`);
  }
  return app;
}

async function createDeploymentPayload(
  cwd: string,
  app: TildeAppDefinition,
  projectSlug: string,
  secrets: Record<string, AgentRuntimeSecrets> = {},
  customToolSecrets: Record<string, string> = {},
): Promise<DeploymentPayload> {
  const agents = (app.agents ?? []).map((item) => ({
    id: item.id,
    path: item.path ?? `/api/agents/${item.id}`,
    description: item.description ?? "",
  }));
  const customTools = (app.tools ?? []).map((item) => ({
    id: item.id,
    path: item.path ?? `/api/tools/${item.id}`,
    description: item.description,
  }));
  const files = await collectProjectFiles(cwd);
  files.push(
    ...generatedFiles(app, agents, customTools, secrets, customToolSecrets),
  );
  return { projectSlug, agents, customTools, files };
}

async function collectProjectFiles(
  cwd: string,
): Promise<HostedAgentDeploymentFile[]> {
  const files: HostedAgentDeploymentFile[] = [];
  await walk(cwd, async (file) => {
    const rel = path.relative(cwd, file).split(path.sep).join("/");
    if (shouldIncludeFile(rel)) {
      files.push({ file: rel, data: await readFile(file, "utf8") });
    }
  });
  if (!files.some((file) => file.file === "package.json")) {
    files.push({
      file: "package.json",
      data: JSON.stringify(
        {
          scripts: { build: "next build" },
          dependencies: {
            next: "latest",
            react: "latest",
            "react-dom": "latest",
          },
          devDependencies: {
            "@types/node": "latest",
            "@types/react": "latest",
            typescript: "latest",
          },
          engines: { node: ">=20" },
          packageManager: "npm@10",
        },
        null,
        2,
      ),
    });
  }
  return files;
}

function generatedFiles(
  app: TildeAppDefinition,
  agents: HostedAgentEndpoint[],
  customTools: HostedCustomToolEndpoint[],
  secrets: Record<string, AgentRuntimeSecrets>,
  customToolSecrets: Record<string, string>,
): HostedAgentDeploymentFile[] {
  const files: HostedAgentDeploymentFile[] = [
    {
      file: "app/api/tilde/agents/route.ts",
      data: `export const dynamic = "force-dynamic";\n\nexport function GET() {\n  return Response.json(${JSON.stringify({ agents }, null, 2)});\n}\n`,
    },
    {
      file: "app/api/tilde/tools/route.ts",
      data: generatedToolManifestRoute(app, customTools, customToolSecrets),
    },
    {
      file: "app/api/tilde/tools/invoke/route.ts",
      data: generatedToolInvokeRoute(app, customToolSecrets),
    },
  ];
  for (const definition of app.agents ?? []) {
    const route = definition.path ?? `/api/agents/${definition.id}`;
    const routeFile = `${route.replace(/^\/api\//, "app/api/")}/route.ts`;
    if (!definition.entrypoint) {
      files.push({
        file: routeFile,
        data: generatedDummyAgentRoute(definition.id, secrets[definition.id]),
      });
      continue;
    }
    const importPath = relativeImport(
      path.posix.dirname(routeFile),
      definition.entrypoint,
    );
    files.push({
      file: routeFile,
      data: `export { POST, GET } from "${importPath}";\n`,
    });
  }
  for (const definition of app.tools ?? []) {
    const route = definition.path ?? `/api/tools/${definition.id}`;
    const routeFile = `${route.replace(/^\/api\//, "app/api/")}/route.ts`;
    const importPath = relativeImport(
      path.posix.dirname(routeFile),
      "app/api/tilde/tools/invoke/route.ts",
    );
    files.push({
      file: routeFile,
      data: `export { POST } from "${importPath}";\n`,
    });
  }
  return files;
}

type AgentRuntimeSecrets = {
  apiKey: string;
  webhookSigningKey: string;
};

function generatedDummyAgentRoute(
  agentId: string,
  secrets: AgentRuntimeSecrets | undefined,
): string {
  return `import { createHmac, timingSafeEqual } from "node:crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const agentId = ${JSON.stringify(agentId)};
const webhookSigningKey = ${JSON.stringify(secrets?.webhookSigningKey ?? "")};

export async function POST(request: Request) {
  const body = await request.text();
  if (webhookSigningKey && !verifyTildeSignature(request, body, webhookSigningKey)) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }
  return Response.json({
    message: {
      id: \`dummy-\${Date.now()}\`,
      role: "assistant",
      parts: [{ type: "text", text: \`dummy response from \${agentId}\` }]
    }
  });
}

function verifyTildeSignature(request: Request, body: string, signingKey: string): boolean {
  const timestamp = request.headers.get("x-tilde-timestamp");
  const signature = request.headers.get("x-tilde-signature");
  if (!timestamp || !signature?.startsWith("hmac-sha256=")) {
    return false;
  }
  const expected = "hmac-sha256=" + createHmac("sha256", signingKey)
    .update(timestamp)
    .update(".")
    .update(body)
    .digest("hex");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
`;
}

function generatedToolManifestRoute(
  app: TildeAppDefinition,
  customTools: HostedCustomToolEndpoint[],
  customToolSecrets: Record<string, string>,
): string {
  const tools = (app.tools ?? []).map((definition) => ({
    type_id: definition.id,
    name: definition.name ?? definition.id,
    description: definition.description,
    input_schema: definition.inputSchema,
    output_schema: definition.outputSchema ?? { type: "object" },
  }));
  const provider = {
    name: app.name ?? "tilde-custom-tools",
    description: "Custom tools deployed with the Tilde CLI",
  };
  const signingKey = Object.values(customToolSecrets)[0] ?? "";
  return `import { createHmac, timingSafeEqual } from "node:crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const provider = ${JSON.stringify(provider, null, 2)};
const tools = ${JSON.stringify(tools, null, 2)};
const toolEndpoints = ${JSON.stringify(customTools, null, 2)};
const signingKey = ${JSON.stringify(signingKey)};

export function GET(request: Request) {
  if (signingKey && !verifyTildeSignature(request, "", signingKey)) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }
  const origin = new URL(request.url).origin;
  return Response.json({
    provider,
    invoke_url: \`\${origin}/api/tilde/tools/invoke\`,
    tools: tools.map((tool) => {
      const endpoint = toolEndpoints.find((item) => item.id === tool.type_id);
      return { ...tool, endpoint_path: endpoint?.path };
    })
  });
}

function verifyTildeSignature(request: Request, body: string, signingKey: string): boolean {
  const timestamp = request.headers.get("x-tilde-timestamp");
  const signature = request.headers.get("x-tilde-signature");
  if (!timestamp || !signature?.startsWith("hmac-sha256=")) {
    return false;
  }
  const expected = "hmac-sha256=" + createHmac("sha256", signingKey)
    .update(timestamp)
    .update(".")
    .update(body)
    .digest("hex");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
`;
}

function generatedToolInvokeRoute(
  app: TildeAppDefinition,
  customToolSecrets: Record<string, string>,
): string {
  const toolIds = (app.tools ?? []).map((definition) => definition.id);
  return `import { createHmac, timingSafeEqual } from "node:crypto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const toolIds = ${JSON.stringify(toolIds, null, 2)};
const signingKeys = ${JSON.stringify(customToolSecrets, null, 2)};

export async function POST(request: Request) {
  const body = await request.text();
  const payload = body ? JSON.parse(body) : {};
  const toolId = String(payload.tool_source_type_id ?? "");
  const signingKey = signingKeys[toolId] ?? "";
  if (signingKey && !verifyTildeSignature(request, body, signingKey)) {
    return Response.json({ type: "error", message: "invalid signature" }, { status: 401 });
  }
  if (!toolIds.includes(toolId)) {
    return Response.json({ type: "error", message: \`unknown tool: \${toolId}\` }, { status: 404 });
  }
  const text = String(payload.params?.text ?? payload.params?.message ?? "hello");
  return Response.json({
    type: "success",
    value: {
      tool: toolId,
      text: \`dummy tool response from \${toolId}: \${text}\`
    }
  });
}

function verifyTildeSignature(request: Request, body: string, signingKey: string): boolean {
  const timestamp = request.headers.get("x-tilde-timestamp");
  const signature = request.headers.get("x-tilde-signature");
  if (!timestamp || !signature?.startsWith("hmac-sha256=")) {
    return false;
  }
  const expected = "hmac-sha256=" + createHmac("sha256", signingKey)
    .update(timestamp)
    .update(".")
    .update(body)
    .digest("hex");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
`;
}

async function walk(
  dir: string,
  visit: (file: string) => Promise<void>,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (![".git", "dist", "node_modules", ".next"].includes(entry.name)) {
        await walk(fullPath, visit);
      }
    } else if (entry.isFile()) {
      await visit(fullPath);
    }
  }
}

function shouldIncludeFile(rel: string): boolean {
  return (
    !/^tilde\.config\.[cm]?[jt]s$/.test(rel) &&
    !rel.startsWith(".") &&
    !rel.includes("/.") &&
    /\.(json|js|jsx|mjs|cjs|ts|tsx|css|md)$/.test(rel)
  );
}

function relativeImport(fromDir: string, toFile: string): string {
  const withoutExtension = toFile.replace(/\.[cm]?[tj]sx?$/, "");
  let rel = path.posix.relative(fromDir, withoutExtension);
  if (!rel.startsWith(".")) {
    rel = `./${rel}`;
  }
  return rel;
}

function auth(rest: string[]): void {
  if (rest[0] === "status") {
    console.log(
      process.env.TILDE_API_KEY || process.env.TILDE_BEARER_TOKEN
        ? "authenticated"
        : "not authenticated",
    );
    return;
  }
  console.log("Usage: tilde auth status");
}

async function invokeHostedAgent(input: {
  endpointUrl: string;
  secrets: AgentRuntimeSecrets | undefined;
}): Promise<string> {
  if (!input.secrets) {
    throw new Error("Cannot invoke hosted agent without ChatKit secrets");
  }
  const body = JSON.stringify({
    messages: [
      {
        id: `user-${cryptoRandomId()}`,
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      },
    ],
  });
  const timestamp = String(Date.now());
  const signature = await hmacSha256Hex(
    input.secrets.webhookSigningKey,
    `${timestamp}.${body}`,
  );
  const response = await fetch(input.endpointUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": input.secrets.apiKey,
      "x-tilde-timestamp": timestamp,
      "x-tilde-signature": `hmac-sha256=${signature}`,
    },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `Hosted agent invocation failed ${response.status}: ${await response.text()}`,
    );
  }
  const json = (await response.json()) as {
    message?: { parts?: Array<{ type?: string; text?: string }> };
  };
  return (
    json.message?.parts
      ?.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
      .join("") ?? ""
  );
}

async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(value),
  );
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function inboxId(value: unknown): string {
  if (
    value &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "string"
  ) {
    return value.id;
  }
  if (
    value &&
    typeof value === "object" &&
    "agent" in value &&
    value.agent &&
    typeof value.agent === "object" &&
    "id" in value.agent &&
    typeof value.agent.id === "string"
  ) {
    return value.agent.id;
  }
  throw new Error("Response did not include an inbox id");
}

function customToolOutput(value: unknown): string {
  if (
    value &&
    typeof value === "object" &&
    "type" in value &&
    value.type === "success" &&
    "value" in value
  ) {
    const output = value.value;
    if (
      output &&
      typeof output === "object" &&
      "text" in output &&
      typeof output.text === "string"
    ) {
      return output.text;
    }
    return JSON.stringify(output);
  }
  return JSON.stringify(value);
}

function cryptoRandomId(): string {
  return globalThis.crypto.randomUUID();
}

function clientPlugin(client: "codex" | "claude", rest: string[]): void {
  if (rest[0] === "install") {
    console.log(`${client} plugin configuration is not implemented yet.`);
    return;
  }
  console.log(`Usage: tilde ${client} install`);
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function compactConfig(
  teamId: string,
  input: Record<
    "orgId" | "baseUrl" | "baseApiUrl" | "apiKey" | "bearerToken",
    string | undefined
  >,
): Config {
  const output: Config = { teamId };
  for (const key of [
    "orgId",
    "baseUrl",
    "baseApiUrl",
    "apiKey",
    "bearerToken",
  ] as const) {
    const value = input[key];
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function printHelp(): void {
  console.log(
    `Usage: tilde <command>\n\nCommands:\n  deploy [--team team_id] [--org org_id] [--project slug] [--dry-run]\n  auth status\n  codex install\n  claude install`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).toString()
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
