import { configHeaders } from "@trytilde/harness-sdk";
import { jsonSchema, type ToolSet, tool } from "ai";
import type { ChatKitEndpointContext } from "./handler";

const MEMORY_TIMEOUT_MS = 30_000;
const MAX_RECALLED_CHARS = 16_000;

export type WorkspaceMemoryRuntime = {
  tools: ToolSet;
  recalled?: string;
  attemptedBankCount: number;
  recalledBankCount: number;
  failedBankCount: number;
};

type WorkspaceMemoryOptions = {
  context: ChatKitEndpointContext;
  headers: Record<string, string>;
  query?: string;
  signal: AbortSignal;
};

/** Bind memory operations exclusively to bank IDs carried in signed workspace context. */
export async function createWorkspaceMemoryRuntime(
  options: WorkspaceMemoryOptions,
): Promise<WorkspaceMemoryRuntime> {
  const bankIds = options.context.runtime?.workspace?.memoryBankIds ?? [];
  const [writeBankId] = bankIds;
  if (!writeBankId) {
    return {
      tools: {},
      attemptedBankCount: 0,
      recalledBankCount: 0,
      failedBankCount: 0,
    };
  }
  const recallResults = options.query?.trim()
    ? await Promise.allSettled(
        bankIds.map((bankId) =>
          memoryRequest(options, bankId, "recall", {
            query: options.query?.trim(),
            max_tokens: 1_500,
          }),
        ),
      )
    : [];
  const recalled = recallResults
    .flatMap((result, index) =>
      result.status === "fulfilled"
        ? [{ bank_id: bankIds[index], result: result.value }]
        : [],
    )
    .filter(({ result }) => hasContent(result));
  const recalledJson =
    recalled.length > 0 ? JSON.stringify(recalled) : undefined;
  const boundedRecalled =
    recalledJson && recalledJson.length <= MAX_RECALLED_CHARS
      ? recalledJson
      : undefined;

  return {
    tools: workspaceMemoryTools(options, bankIds, writeBankId),
    ...(boundedRecalled ? { recalled: boundedRecalled } : {}),
    attemptedBankCount: recallResults.length,
    recalledBankCount: recalled.length,
    failedBankCount:
      recallResults.filter((result) => result.status === "rejected").length +
      (recalledJson && !boundedRecalled ? 1 : 0),
  };
}

function workspaceMemoryTools(
  options: WorkspaceMemoryOptions,
  bankIds: string[],
  writeBankId: string,
): ToolSet {
  return {
    memory_search: tool({
      description:
        "Search durable memory readable by this signed workspace. Use this before repeating discovery or asking for previously established facts.",
      inputSchema: jsonSchema<{ query: string; max_tokens?: number }>({
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          max_tokens: { type: "integer", minimum: 1, maximum: 8_000 },
        },
        required: ["query"],
        additionalProperties: false,
      }),
      execute: async ({ query, max_tokens }) => {
        const results = await Promise.all(
          bankIds.map(async (bankId) => ({
            bank_id: bankId,
            result: await memoryRequest(options, bankId, "recall", {
              query,
              max_tokens: max_tokens ?? 2_000,
            }),
          })),
        );
        return { results };
      },
    }),
    memory_reflect: tool({
      description:
        "Ask durable workspace memory to synthesize a contextual answer across every readable bank.",
      inputSchema: jsonSchema<{ query: string }>({
        type: "object",
        properties: { query: { type: "string", minLength: 1 } },
        required: ["query"],
        additionalProperties: false,
      }),
      execute: async ({ query }) => {
        const results = await Promise.all(
          bankIds.map(async (bankId) => ({
            bank_id: bankId,
            result: await memoryRequest(options, bankId, "reflect", { query }),
          })),
        );
        return { results };
      },
    }),
    memory_remember: tool({
      description:
        "Retain or replace one stable, non-secret fact document in this workspace's writable memory bank. Reuse document_id when updating the same fact.",
      inputSchema: jsonSchema<{
        document_id: string;
        content: string;
        tags?: string[];
      }>({
        type: "object",
        properties: {
          document_id: { type: "string", minLength: 1, maxLength: 1_000 },
          content: { type: "string", minLength: 1 },
          tags: { type: "array", items: { type: "string" }, maxItems: 32 },
        },
        required: ["document_id", "content"],
        additionalProperties: false,
      }),
      execute: ({ document_id, content, tags }) =>
        memoryRequest(options, writeBankId, "retain", {
          document: {
            document_id,
            content,
            metadata: {
              source: "agent_workspace",
              workspace_id: options.context.runtime?.workspace?.id,
              workspace_kind: options.context.runtime?.workspace?.kind,
            },
            tags: tags ?? [],
          },
        }),
    }),
    memory_forget: tool({
      description:
        "Delete one manually retained fact from this workspace's writable memory bank by its original document_id.",
      inputSchema: jsonSchema<{ document_id: string }>({
        type: "object",
        properties: {
          document_id: { type: "string", minLength: 1, maxLength: 1_000 },
        },
        required: ["document_id"],
        additionalProperties: false,
      }),
      execute: async ({ document_id }) => {
        await memoryRequest(
          options,
          writeBankId,
          "documents",
          { document_id },
          "DELETE",
        );
        return { deleted: true, document_id };
      },
    }),
  };
}

async function memoryRequest(
  options: WorkspaceMemoryOptions,
  bankId: string,
  path: string,
  body: unknown,
  method = "POST",
): Promise<unknown> {
  const config = options.context.client.config;
  const headers = configHeaders(config);
  if (options.headers.authorization && config.apiKey) {
    headers.delete("authorization");
    headers.set("x-api-key", config.apiKey);
  }
  for (const [name, value] of Object.entries(options.headers)) {
    headers.set(name, value);
  }
  headers.set("content-type", "application/json");
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/api/v1/team/${encodeURIComponent(options.context.teamId)}/memory/banks/${encodeURIComponent(bankId)}/${path}`;
  const response = await (config.fetch ?? fetch)(url, {
    method,
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.any([
      options.signal,
      AbortSignal.timeout(MEMORY_TIMEOUT_MS),
    ]),
  });
  if (!response.ok) {
    throw new Error(
      `Workspace memory ${path} failed (${response.status}): ${await response.text()}`,
    );
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function hasContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}
