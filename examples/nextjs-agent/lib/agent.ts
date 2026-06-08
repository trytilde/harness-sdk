import { createMCPClient } from "@ai-sdk/mcp";
import {
  convertToModelMessages,
  streamText,
  type ToolSet,
  type UIMessage,
} from "ai";
import { tildeAiGateway, tildeMcpServerUrl } from "./tilde";

export type AgentRequestBody = {
  messages: UIMessage[];
};

export async function runAgent(body: AgentRequestBody) {
  const gateway = tildeAiGateway();
  const apiKey = process.env.TILDE_API_KEY;
  if (!apiKey) {
    throw new Error("Missing required environment variable: TILDE_API_KEY");
  }

  const mcp = await createMCPClient({
    transport: {
      type: "http",
      url: tildeMcpServerUrl(),
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    },
  });

  try {
    const tools: ToolSet = await mcp.tools();
    const result = streamText({
      model: gateway(process.env.TILDE_AI_GATEWAY_MODEL || "gpt-5-mini"),
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
