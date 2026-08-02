import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatKitEndpointContext } from "../src";

const mocks = vi.hoisted(() => ({
  closeMcp: vi.fn(async () => undefined),
  createMCPClient: vi.fn(),
  tools: vi.fn(async () => ({})),
}));

vi.mock("../src/mcp", () => ({
  createMCPClient: mocks.createMCPClient,
}));

import { runAgent } from "../src/agent";

describe("runAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createMCPClient.mockResolvedValue({
      mcp: { tools: mocks.tools },
      closeMcp: mocks.closeMcp,
    });
  });

  it("requires server-owned runtime bindings", async () => {
    await expect(
      runAgent(new Request("https://example.test"), context(), {
        model: new MockLanguageModelV3(),
      }),
    ).rejects.toThrow("configured signed runtime");
    expect(mocks.createMCPClient).not.toHaveBeenCalled();
  });

  it("runs the configured bounded model and closes MCP after streaming", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", delta: "Done" },
          { type: "text-end", id: "text-1" },
          {
            type: "finish",
            finishReason: { unified: "stop" as const, raw: "stop" },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ]),
      }),
    });
    const resolveModel = vi.fn(() => model);
    const onEvent = vi.fn();
    const runtimeContext = context({
      runtime: {
        agent_inbox_id: "agent_1",
        agent_inbox_instance_id: "instance_1",
        org_id: "org_1",
        team_id: "team_1",
        session_id: "session_1",
        actor: {
          tilde_user_id: "user_1",
          external_user_provider_account_id: "account_1",
        },
        configuration: {
          mcp_server_id: "mcp_1",
          skill_registry_id: null,
          system_prompt: "Operate the company.",
          model: "gpt-5.4",
          max_steps: 7,
          max_history_messages: 2,
          security_posture: "strict",
        },
      },
    });

    const response = await runAgent(
      new Request("https://example.test", { method: "POST" }),
      runtimeContext,
      { model: resolveModel, onEvent },
    );
    await response.text();

    expect(resolveModel).toHaveBeenCalledWith("gpt-5.4");
    expect(mocks.createMCPClient).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "mcp_1",
        headers: expect.objectContaining({
          "x-tilde-agent-inbox-id": "agent_1",
          "x-tilde-agent-inbox-instance-id": "instance_1",
          "x-tilde-session-id": "session_1",
        }),
      }),
    );
    expect(model.doStreamCalls).toHaveLength(1);
    expect(mocks.closeMcp).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "started", model: "gpt-5.4" }),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "finished" }),
    );
  });
});

function context(
  overrides: Partial<ChatKitEndpointContext> = {},
): ChatKitEndpointContext {
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
    client: {} as ChatKitEndpointContext["client"],
    skills: {} as ChatKitEndpointContext["skills"],
    session: {
      id: "session_1",
      history: async () => ({ items: [] }),
    },
    chatkit: {
      cacheConvertedMessages: async () => ({ success: true }),
      hydrateConvertedMessages: async () => ({ messages: [] }),
    },
    ...overrides,
  };
}
