import { describe, expect, it, vi } from "vitest";
import type { ChatKitEndpointContext } from "../src";
import { createWorkspaceMemoryRuntime } from "../src/workspace-memory";

describe("workspace memory", () => {
  it("recalls only signed banks and pairs actor delegation with the agent API key", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ result: { facts: ["Prefers concise reports"] } }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const runtime = await createWorkspaceMemoryRuntime({
      context: context(fetch),
      headers: {
        authorization: "Bearer delegated-user-token",
        "x-tilde-agent-workspace-id": "workspace_1",
      },
      query: "How should I report this?",
      signal: new AbortController().signal,
    });

    expect(runtime).toMatchObject({
      attemptedBankCount: 2,
      recalledBankCount: 2,
      failedBankCount: 0,
    });
    expect(runtime.recalled).toContain("Prefers concise reports");
    expect(fetch).toHaveBeenCalledTimes(2);
    const firstCall = fetch.mock.calls[0];
    if (!firstCall) throw new Error("expected memory recall request");
    const [firstUrl, firstInit] = firstCall;
    expect(String(firstUrl)).toContain("/memory/banks/bank_personal/recall");
    const headers = new Headers(firstInit?.headers);
    expect(headers.get("x-api-key")).toBe("agent-api-key");
    expect(headers.get("authorization")).toBe("Bearer delegated-user-token");
    expect(headers.get("x-tilde-agent-workspace-id")).toBe("workspace_1");
  });

  it("writes only to the first signed bank", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ result: { retained: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const runtime = await createWorkspaceMemoryRuntime({
      context: context(fetch),
      headers: {},
      signal: new AbortController().signal,
    });
    const remember = runtime.tools.memory_remember as unknown as {
      execute(input: unknown, options: unknown): Promise<unknown>;
    };

    await remember.execute(
      { document_id: "report-style", content: "Prefer concise reports." },
      {},
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    const firstCall = fetch.mock.calls[0];
    if (!firstCall) throw new Error("expected memory retain request");
    const [url, init] = firstCall;
    expect(String(url)).toContain("/memory/banks/bank_personal/retain");
    expect(String(url)).not.toContain("bank_team");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      document: {
        document_id: "report-style",
        content: "Prefer concise reports.",
        metadata: { workspace_id: "workspace_1" },
      },
    });
  });
});

function context(fetch: typeof globalThis.fetch): ChatKitEndpointContext {
  const messages = [
    {
      id: "message_1",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "Do the work." }],
    },
  ];
  return {
    rawBody: new Uint8Array(),
    body: { messages },
    messages,
    webhookId: "webhook_1",
    timestamp: 1,
    orgId: "org_1",
    teamId: "team_1",
    sessionId: "session_1",
    client: {
      config: {
        baseUrl: "https://api.example.test",
        teamId: "team_1",
        apiKey: "agent-api-key",
        fetch,
      },
    } as ChatKitEndpointContext["client"],
    skills: {} as ChatKitEndpointContext["skills"],
    session: { id: "session_1", history: async () => ({ items: [] }) },
    chatkit: {
      cacheConvertedMessages: async () => ({ success: true }),
      hydrateConvertedMessages: async () => ({ messages: [] }),
    },
    runtime: {
      agent_inbox_id: "agent_1",
      agent_inbox_instance_id: "instance_1",
      org_id: "org_1",
      team_id: "team_1",
      session_id: "session_1",
      actor: { tilde_user_id: "user_1" },
      configuration: {
        mcp_server_id: "mcp_1",
        max_steps: 10,
        max_history_messages: 50,
        security_posture: "auto",
      },
      workspace: {
        id: "workspace_1",
        kind: "personal",
        subjectId: "tilde:user_1",
        memoryBankIds: ["bank_personal", "bank_team"],
        credentialMode: "invoking_actor",
        invocationPolicy: {
          securityPosture: "auto",
          deniedToolIds: [],
          approvalRequiredToolIds: [],
          deniedCommandPatterns: [],
          maxWallClockSeconds: 300,
        },
        automationEnabled: true,
        appPublishingEnabled: false,
      },
    },
  };
}
