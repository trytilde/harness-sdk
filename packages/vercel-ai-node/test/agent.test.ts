import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentWorkspaceInvocationContext,
  ChatKitEndpointContext,
} from "../src";

const mocks = vi.hoisted(() => ({
  closeMcp: vi.fn(async () => undefined),
  createMCPClient: vi.fn(),
  tools: vi.fn(async () => ({})),
}));

vi.mock("../src/mcp", () => ({
  createMCPClient: mocks.createMCPClient,
}));

import { applyRuntimePolicy, runAgent } from "../src/agent";
import { createVercelAiAgentHarness } from "../src/agent-harness";

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

  it("exposes the Vercel runner through the portable harness profile", () => {
    const harness = createVercelAiAgentHarness({
      model: new MockLanguageModelV3(),
    });

    expect(harness.profile).toMatchObject({
      id: "vercel-ai-sdk",
      controlTransport: "in-process",
      toolTransport: "mcp",
      transcriptFormat: "chatkit-ui-message",
    });
    expect(harness.profile.capabilities.has("workspace-policy")).toBe(true);
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
      new Request("https://example.test", {
        method: "POST",
        headers: { "x-tilde-agent-delegation": "delegated-user-token" },
      }),
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
          authorization: "Bearer delegated-user-token",
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

describe("workspace runtime policy", () => {
  it("removes denied tools and marks selected tools for approval", () => {
    const tools = applyRuntimePolicy(
      {
        provider__denied: { description: "denied" },
        provider__reviewed: { description: "reviewed" },
      } as never,
      "dangerous",
      workspace({
        deniedToolIds: ["denied"],
        approvalRequiredToolIds: ["reviewed"],
      }),
    );

    expect(tools.provider__denied).toBeUndefined();
    expect(tools.provider__reviewed).toMatchObject({ needsApproval: true });
  });

  it("binds the signed sandbox and rejects denied command inputs", async () => {
    const execute = vi.fn(async (input: unknown) => input);
    const onEvent = vi.fn();
    const tools = applyRuntimePolicy(
      { e2b_exec_command: { execute } } as never,
      "auto",
      workspace({ deniedCommandPatterns: ["rm\\s+-rf"] }),
      onEvent,
    );
    const run = tools.e2b_exec_command as unknown as {
      execute(input: unknown, options: unknown): Promise<unknown>;
    };

    await expect(
      run.execute({ sandbox_id: "caller-id", command: "pwd" }, {}),
    ).resolves.toEqual({ sandbox_id: "workspace-sandbox", command: "pwd" });
    await expect(
      run.execute({ sandbox_id: "caller-id", command: "rm -rf /tmp/x" }, {}),
    ).rejects.toThrow("denied command pattern");
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "policy-denied",
        toolName: "e2b_exec_command",
      }),
    );
  });

  it("captures a newly created sandbox for durable workspace binding", async () => {
    const onSandboxCreated = vi.fn(async () => undefined);
    const tools = applyRuntimePolicy(
      {
        e2b_create_sandbox: {
          execute: async () => ({ data: { sandboxID: "new-sandbox" } }),
        },
      } as never,
      "auto",
      {
        ...workspace(),
        sandbox: {
          toolProviderInstanceId: "e2b-company-agent",
          sandboxId: null,
          scratch: false,
        },
      },
      undefined,
      onSandboxCreated,
    );
    const create = tools.e2b_create_sandbox as unknown as {
      execute(input: unknown, options: unknown): Promise<unknown>;
    };

    await create.execute({}, {});

    expect(onSandboxCreated).toHaveBeenCalledWith("new-sandbox");
  });
});

function workspace(
  policy: Partial<AgentWorkspaceInvocationContext["invocationPolicy"]> = {},
): AgentWorkspaceInvocationContext {
  return {
    id: "workspace_1",
    kind: "personal",
    subjectId: "tilde:user_1",
    memoryBankIds: [],
    credentialMode: "invoking_actor",
    sandbox: {
      toolProviderInstanceId: "e2b-company-agent",
      sandboxId: "workspace-sandbox",
      scratch: false,
    },
    invocationPolicy: {
      securityPosture: "auto",
      deniedToolIds: [],
      approvalRequiredToolIds: [],
      deniedCommandPatterns: [],
      maxWallClockSeconds: 300,
      ...policy,
    },
    automationEnabled: true,
    appPublishingEnabled: true,
  };
}

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
