import { createMCPClient } from "@tilde/harness-sdk-vercel-ai-node";
import {
  convertToModelMessages,
  streamText,
  type ToolSet,
  type UIMessage,
} from "ai";
import { modelProvider, tilde } from "./tilde";

export type AgentRequestBody = {
  messages: UIMessage[];
};

export async function runAgent(body: AgentRequestBody) {
  const provider = modelProvider();
  const mcp = await createMCPClient({
    client: tilde,
    serverId: process.env.TILDE_MCP_SERVER_ID || "my-agent-tools",
  });

  try {
    const tools: ToolSet = await mcp.tools();
    const result = streamText({
      model: provider(process.env.MODEL_NAME || "gpt-5-mini"),
      messages: await convertToModelMessages(body.messages),
      tools,
      async onFinish() {
        await mcp.close();
      },
    });

    return result.toUIMessageStreamResponse();
  } catch (error) {
    await mcp.close();
    throw error;
  }
}
