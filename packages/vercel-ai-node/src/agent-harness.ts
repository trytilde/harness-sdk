import { type RunAgentOptions, runAgent } from "./agent";
import type { ChatKitEndpointContext } from "./handler";

export type AgentHarnessControlTransport =
  | "in-process"
  | "sdk"
  | "http"
  | "json-rpc";

export type AgentHarnessToolTransport = "dynamic" | "in-process-mcp" | "mcp";

export type AgentHarnessCapability =
  | "abort"
  | "streaming"
  | "tool-approval"
  | "workspace-policy"
  | "provider-sessions";

export type AgentHarnessProfile = {
  id: string;
  controlTransport: AgentHarnessControlTransport;
  toolTransport: AgentHarnessToolTransport;
  transcriptFormat: string;
  capabilities: ReadonlySet<AgentHarnessCapability>;
};

export type AgentHarnessTurnInput = {
  request: Request;
  context: ChatKitEndpointContext;
};

/** Portable boundary implemented by any configured ChatKit agent harness. */
export type AgentHarness = {
  profile: AgentHarnessProfile;
  runTurn(input: AgentHarnessTurnInput): Promise<Response>;
  resetSession?(sessionId: string): void | Promise<void>;
  close?(): void | Promise<void>;
};

export function defineAgentHarness(
  profile: AgentHarnessProfile,
  implementation: Omit<AgentHarness, "profile">,
): AgentHarness {
  return { profile, ...implementation };
}

/** Invoke a selected harness without coupling the ChatKit route to its backend. */
export function runAgentWithHarness(
  harness: AgentHarness,
  request: Request,
  context: ChatKitEndpointContext,
): Promise<Response> {
  return harness.runTurn({ request, context });
}

/** Vercel AI SDK adapter for the portable configured-agent harness boundary. */
export function createVercelAiAgentHarness(
  options: RunAgentOptions,
): AgentHarness {
  return defineAgentHarness(
    {
      id: "vercel-ai-sdk",
      controlTransport: "in-process",
      toolTransport: "mcp",
      transcriptFormat: "chatkit-ui-message",
      capabilities: new Set([
        "abort",
        "streaming",
        "tool-approval",
        "workspace-policy",
      ]),
    },
    {
      runTurn: ({ request, context }) => runAgent(request, context, options),
    },
  );
}
