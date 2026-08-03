import { Buffer } from "node:buffer";
import {
  configHeaders,
  type JsonObject,
  type JsonValue,
  type SkillItem,
} from "@trytilde/harness-sdk";
import {
  consumeStream,
  convertToModelMessages,
  createUIMessageStreamResponse,
  jsonSchema,
  type LanguageModel,
  stepCountIs,
  streamText,
  type ToolSet,
  tool,
  type UIMessageChunk,
} from "ai";
import { convertToAiSdkMessages } from "./chatkit-message";
import type {
  AgentWorkspaceInvocationContext,
  ChatKitAgentSecurityPosture,
} from "./chatkit-request";
import type { ChatKitEndpointContext } from "./handler";
import { createMCPClient } from "./mcp";

export type AgentRunEvent =
  | {
      type: "started";
      model?: string;
      historyMessageCount: number;
      toolCount: number;
    }
  | {
      type: "finished";
      usage?: JsonObject;
    }
  | {
      type: "failed";
      error: string;
    }
  | {
      type: "policy-denied";
      toolName: string;
      reason: string;
    };

export type RunAgentOptions = {
  /** Resolve the configured model name to a Vercel AI SDK language model. */
  model: LanguageModel | ((modelName?: string) => LanguageModel);
  /** Used when the server-owned runtime has no system prompt. */
  system?: string;
  /** Additional local tools exposed alongside the configured Tilde MCP server. */
  tools?: ToolSet;
  /** Receives lifecycle and aggregate usage telemetry without message content. */
  onEvent?: (event: AgentRunEvent) => void | Promise<void>;
};

/**
 * Run a configured Tilde agent from a verified ChatKit request.
 *
 * The Tilde API owns the runtime bindings. This runner restores durable session
 * history, progressively exposes registered skills, connects the assigned MCP
 * server, applies the configured approval posture, and bounds the model loop.
 */
export async function runAgent(
  request: Request,
  context: ChatKitEndpointContext,
  options: RunAgentOptions,
): Promise<Response> {
  if (!context.runtime) {
    throw new TypeError(
      "runAgent requires a ChatKit agent with a configured signed runtime",
    );
  }

  const runtime = context.runtime.configuration;
  const history = await context.session.history();
  const combined = [...history.items, ...context.messages];
  const boundedHistory = combined.slice(-runtime.max_history_messages);
  const messages = await convertToAiSdkMessages({
    messages: boundedHistory,
    chatkit: context.chatkit,
  });
  const skillRuntime = await createSkillRuntime(context);
  const localTools: ToolSet = {
    ...skillRuntime.tools,
    ...options.tools,
  };
  let mcpHandle: Awaited<ReturnType<typeof createMCPClient>> | undefined;
  const auditEvents: AgentRunEvent[] = [];
  const emitEvent = async (event: AgentRunEvent) => {
    auditEvents.push(event);
    await options.onEvent?.(event);
  };

  try {
    mcpHandle = await createMCPClient({
      client: context.client,
      serverId: runtime.mcp_server_id,
      tools: localTools,
      headers: actorHeaders(
        context,
        request.headers.get("x-tilde-agent-delegation"),
      ),
    });
    const tools = applyRuntimePolicy(
      (await mcpHandle.mcp.tools()) as ToolSet,
      runtime.security_posture,
      context.runtime.workspace ?? undefined,
      emitEvent,
      async (sandboxId) => {
        await bindWorkspaceSandbox(context, sandboxId);
        const sandbox = context.runtime?.workspace?.sandbox;
        if (sandbox) sandbox.sandboxId = sandboxId;
      },
    );
    const model =
      typeof options.model === "function"
        ? options.model(runtime.model ?? undefined)
        : options.model;
    await emitEvent({
      type: "started",
      ...(runtime.model ? { model: runtime.model } : {}),
      historyMessageCount: messages.length,
      toolCount: Object.keys(tools).length,
    });

    const wallClockSeconds =
      context.runtime.workspace?.invocationPolicy.maxWallClockSeconds;
    const abortSignal = wallClockSeconds
      ? AbortSignal.any([
          request.signal,
          AbortSignal.timeout(wallClockSeconds * 1_000),
        ])
      : request.signal;
    const result = streamText({
      model,
      system: systemPrompt(
        runtime.system_prompt ?? options.system,
        skillRuntime.catalog,
      ),
      messages: await convertToModelMessages(messages),
      tools,
      stopWhen: stepCountIs(runtime.max_steps),
      abortSignal,
      async onFinish(event) {
        await emitEvent({
          type: "finished",
          usage: event.totalUsage as unknown as JsonObject,
        });
      },
    });

    let emittedAuditEvents = 0;
    const stream = result.toUIMessageStream().pipeThrough(
      new TransformStream<UIMessageChunk, UIMessageChunk>({
        transform(chunk, controller) {
          while (emittedAuditEvents < auditEvents.length) {
            const event = auditEvents[emittedAuditEvents++];
            if (!event) break;
            controller.enqueue(agentRunEventChunk(event));
          }
          controller.enqueue(chunk);
        },
        async flush(controller) {
          while (emittedAuditEvents < auditEvents.length) {
            const event = auditEvents[emittedAuditEvents++];
            if (!event) break;
            controller.enqueue(agentRunEventChunk(event));
          }
          await mcpHandle?.closeMcp();
        },
      }),
    );
    return createUIMessageStreamResponse({
      stream,
      consumeSseStream: consumeStream,
    });
  } catch (error) {
    await mcpHandle?.closeMcp();
    await emitEvent({
      type: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function agentRunEventChunk(event: AgentRunEvent): UIMessageChunk {
  return {
    type: "data-agent-run",
    data: event,
    transient: false,
  };
}

async function createSkillRuntime(context: ChatKitEndpointContext): Promise<{
  catalog: SkillItem[];
  tools: ToolSet;
}> {
  const registryId = context.runtime?.configuration.skill_registry_id;
  if (!registryId) return { catalog: [], tools: {} };
  const registry = await context.skills.registry(registryId);
  const catalog = await registry.list();
  const readInput = jsonSchema<{ skill: string }>({
    type: "object",
    properties: {
      skill: {
        type: "string",
        description: "Skill ID or exact skill name from list_skills.",
      },
    },
    required: ["skill"],
    additionalProperties: false,
  });
  const fileInput = jsonSchema<{ skill: string; path: string }>({
    type: "object",
    properties: {
      skill: { type: "string", description: "Skill ID or exact skill name." },
      path: { type: "string", description: "Path from the package manifest." },
    },
    required: ["skill", "path"],
    additionalProperties: false,
  });

  return {
    catalog,
    tools: {
      list_skills: tool({
        description:
          "List the available operating procedures and specialist skills. Read a relevant skill before acting.",
        inputSchema: jsonSchema({
          type: "object",
          properties: {},
          additionalProperties: false,
        }),
        execute: async () => catalog.map(skillSummary),
      }),
      read_skill: tool({
        description:
          "Read a skill's primary instructions and immutable package file manifest.",
        inputSchema: readInput,
        execute: async ({ skill }) => {
          const item = await registry.find(skill);
          const manifest = await context.skills
            .package(item.id)
            .manifest()
            .catch(() => null);
          return {
            skill: skillSummary(item),
            instructions: item.content,
            package: manifest,
          };
        },
      }),
      read_skill_file: tool({
        description:
          "Read one supporting file from a skill package after inspecting its manifest.",
        inputSchema: fileInput,
        execute: async ({ skill, path }) => {
          const item = await registry.find(skill);
          const content = await context.skills.package(item.id).download(path);
          let encoding = "utf8";
          let decoded: string;
          try {
            decoded = new TextDecoder("utf-8", { fatal: true }).decode(content);
          } catch {
            encoding = "base64";
            decoded = Buffer.from(content).toString("base64");
          }
          return {
            skill_id: item.id,
            path,
            encoding,
            content: decoded,
          };
        },
      }),
    },
  };
}

function skillSummary(skill: SkillItem) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    source_repository_url: skill.source_repository_url,
    source_commit_hash: skill.source_commit_hash,
    source_path: skill.source_path,
  };
}

function systemPrompt(base: string | undefined, catalog: SkillItem[]): string {
  const prompt = base?.trim() || "You are a capable company operating agent.";
  if (catalog.length === 0) return prompt;
  const skills = catalog
    .map((skill) => `- ${skill.name}: ${skill.description}`)
    .join("\n");
  return `${prompt}\n\nAvailable skills:\n${skills}\n\nUse list_skills and read_skill progressively before applying a relevant procedure.`;
}

function actorHeaders(
  context: ChatKitEndpointContext,
  delegationToken?: string | null,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      "x-tilde-org-id": context.orgId,
      "x-tilde-team-id": context.teamId,
      "x-tilde-session-id": context.sessionId,
      "x-tilde-agent-inbox-id": context.runtime?.agent_inbox_id,
      "x-tilde-agent-inbox-instance-id":
        context.runtime?.agent_inbox_instance_id,
      "x-tilde-user-id": context.userId,
      "x-external-user-id": context.externalUserId,
      "x-external-user-provider": context.externalUserProvider,
      "x-external-user-provider-account-id":
        context.externalUserProviderAccountId,
      "x-tilde-agent-workspace-id": context.runtime?.workspace?.id,
      "x-tilde-agent-workspace-kind": context.runtime?.workspace?.kind,
      "x-tilde-agent-workspace-subject": context.runtime?.workspace?.subjectId,
      "x-tilde-agent-credential-mode":
        context.runtime?.workspace?.credentialMode,
      authorization: delegationToken ? `Bearer ${delegationToken}` : undefined,
    }).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

export function applyRuntimePolicy(
  tools: ToolSet,
  posture: ChatKitAgentSecurityPosture,
  workspace?: AgentWorkspaceInvocationContext,
  onEvent?: RunAgentOptions["onEvent"],
  onSandboxCreated?: (sandboxId: string) => void | Promise<void>,
): ToolSet {
  const deniedTools = new Set(workspace?.invocationPolicy.deniedToolIds ?? []);
  const approvalTools = new Set(
    workspace?.invocationPolicy.approvalRequiredToolIds ?? [],
  );
  const effectivePosture = stricterPosture(
    posture,
    workspace?.invocationPolicy.securityPosture,
  );
  const deniedPatterns = (
    workspace?.invocationPolicy.deniedCommandPatterns ?? []
  ).map((pattern) => {
    try {
      return { source: pattern, regex: new RegExp(pattern, "i") };
    } catch (error) {
      throw new TypeError(
        `Invalid signed workspace command policy ${JSON.stringify(pattern)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
  return Object.fromEntries(
    Object.entries(tools)
      .filter(([name]) => !matchesPolicyTool(name, deniedTools))
      .map(([name, value]) => {
        const executable = value as ToolSet[string] & {
          execute?: (
            input: unknown,
            options: unknown,
          ) => unknown | Promise<unknown>;
        };
        const result = {
          ...value,
          ...(effectivePosture === "strict" ||
          matchesPolicyTool(name, approvalTools)
            ? { needsApproval: true }
            : {}),
        } as typeof executable;
        if (
          executable.execute &&
          (deniedPatterns.length > 0 ||
            workspace?.sandbox?.sandboxId ||
            (workspace?.sandbox && isSandboxCreateTool(name)))
        ) {
          const execute = executable.execute;
          result.execute = async (input, executeOptions) => {
            const serialized = JSON.stringify(input);
            const denied = deniedPatterns.find(({ regex }) =>
              regex.test(serialized),
            );
            if (denied) {
              const reason = `Tool input matched denied command pattern: ${denied.source}`;
              await onEvent?.({
                type: "policy-denied",
                toolName: name,
                reason,
              });
              throw new Error(reason);
            }
            const output = await execute(
              bindSandboxInput(input, workspace?.sandbox?.sandboxId),
              executeOptions,
            );
            if (isSandboxCreateTool(name)) {
              const sandboxId = findSandboxId(output);
              if (!sandboxId) {
                throw new Error(
                  "Sandbox creation succeeded without returning a sandbox ID",
                );
              }
              await onSandboxCreated?.(sandboxId);
            }
            return output;
          };
        }
        return [name, result];
      }),
  ) as ToolSet;
}

function matchesPolicyTool(name: string, configuredIds: Set<string>): boolean {
  if (configuredIds.has(name)) return true;
  for (const id of configuredIds) {
    if (name.endsWith(`__${id}`)) return true;
  }
  return false;
}

async function bindWorkspaceSandbox(
  context: ChatKitEndpointContext,
  sandboxId: string,
): Promise<void> {
  const workspace = context.runtime?.workspace;
  if (!workspace?.sandbox || workspace.sandbox.sandboxId === sandboxId) return;
  const headers = configHeaders(context.client.config);
  headers.set("content-type", "application/json");
  for (const [key, value] of Object.entries(actorHeaders(context))) {
    headers.set(key, value);
  }
  const baseUrl = context.client.config.baseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/api/v1/team/${encodeURIComponent(context.teamId)}/chatkit/workspaces/${encodeURIComponent(workspace.id)}/sandbox`;
  const response = await (context.client.config.fetch ?? fetch)(url, {
    method: "PUT",
    headers,
    body: JSON.stringify({ sandboxId }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to persist agent workspace sandbox (${response.status}): ${await response.text()}`,
    );
  }
}

function isSandboxCreateTool(name: string): boolean {
  return name === "e2b_create_sandbox" || name.endsWith("__e2b_create_sandbox");
}

function findSandboxId(value: unknown, depth = 0): string | undefined {
  if (depth > 5 || value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSandboxId(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === "string") {
    if (!value.trim().startsWith("{") && !value.trim().startsWith("[")) {
      return undefined;
    }
    try {
      return findSandboxId(JSON.parse(value) as JsonValue, depth + 1);
    } catch {
      return undefined;
    }
  }
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["sandboxID", "sandboxId", "sandbox_id"]) {
    if (typeof record[key] === "string" && record[key]) {
      return record[key];
    }
  }
  for (const nested of Object.values(record)) {
    const found = findSandboxId(nested, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function stricterPosture(
  agent: ChatKitAgentSecurityPosture,
  workspace?: ChatKitAgentSecurityPosture,
): ChatKitAgentSecurityPosture {
  const rank: Record<ChatKitAgentSecurityPosture, number> = {
    dangerous: 0,
    auto: 1,
    strict: 2,
  };
  return workspace && rank[workspace] > rank[agent] ? workspace : agent;
}

function bindSandboxInput(input: unknown, sandboxId?: string | null): unknown {
  if (
    !sandboxId ||
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    return input;
  }
  const record = input as Record<string, unknown>;
  if ("sandboxId" in record) return { ...record, sandboxId };
  if ("sandbox_id" in record) return { ...record, sandbox_id: sandboxId };
  return input;
}
