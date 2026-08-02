import { Buffer } from "node:buffer";
import type { JsonObject, SkillItem } from "@trytilde/harness-sdk";
import {
  consumeStream,
  convertToModelMessages,
  jsonSchema,
  type LanguageModel,
  stepCountIs,
  streamText,
  type ToolSet,
  tool,
} from "ai";
import { convertToAiSdkMessages } from "./chatkit-message";
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

  try {
    mcpHandle = await createMCPClient({
      client: context.client,
      serverId: runtime.mcp_server_id,
      tools: localTools,
      headers: actorHeaders(context),
    });
    const tools = applySecurityPosture(
      (await mcpHandle.mcp.tools()) as ToolSet,
      runtime.security_posture,
    );
    const model =
      typeof options.model === "function"
        ? options.model(runtime.model ?? undefined)
        : options.model;
    await options.onEvent?.({
      type: "started",
      ...(runtime.model ? { model: runtime.model } : {}),
      historyMessageCount: messages.length,
      toolCount: Object.keys(tools).length,
    });

    const result = streamText({
      model,
      system: systemPrompt(
        runtime.system_prompt ?? options.system,
        skillRuntime.catalog,
      ),
      messages: await convertToModelMessages(messages),
      tools,
      stopWhen: stepCountIs(runtime.max_steps),
      abortSignal: request.signal,
      async onFinish(event) {
        await options.onEvent?.({
          type: "finished",
          usage: event.totalUsage as unknown as JsonObject,
        });
      },
    });

    return result.toUIMessageStreamResponse({
      async onFinish() {
        await mcpHandle?.closeMcp();
      },
      consumeSseStream: consumeStream,
    });
  } catch (error) {
    await mcpHandle?.closeMcp();
    await options.onEvent?.({
      type: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
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

function actorHeaders(context: ChatKitEndpointContext): Record<string, string> {
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
    }).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

function applySecurityPosture(
  tools: ToolSet,
  posture: "auto" | "strict" | "dangerous",
): ToolSet {
  if (posture !== "strict") return tools;
  return Object.fromEntries(
    Object.entries(tools).map(([name, value]) => [
      name,
      { ...value, needsApproval: true },
    ]),
  ) as ToolSet;
}
