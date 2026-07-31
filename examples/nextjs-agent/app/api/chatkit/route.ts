import { createClient } from "@trytilde/harness-sdk";
import {
  chatKitEndpoint,
  convertToAiSdkMessages,
  createChatKitAttachmentFilePartHandler,
} from "@trytilde/harness-sdk-vercel-ai-node";
import {
  consumeStream,
  convertToModelMessages,
  jsonSchema,
  streamText,
  tool,
} from "ai";
import { modelProvider } from "@/lib/tilde";

export const maxDuration = 60;

const client = createClient({
  apiKey: process.env.TILDE_API_KEY,
  baseUrl: process.env.TILDE_BASE_URL,
  orgId: process.env.TILDE_ORG_ID,
  teamId: process.env.TILDE_TEAM_ID,
});

async function waitForAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    throw new Error("hangUntilAbort aborted before it started");
  }

  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new Error("hangUntilAbort aborted")),
      { once: true },
    );
  });
}

export const POST = chatKitEndpoint({
  webhookSigningKey: process.env.TILDE_CHATKIT_WEBHOOK_SIGNING_KEY || "",
  client,
  async handler(request, context) {
    const history = await context.session.history();
    const messages = await convertToAiSdkMessages({
      messages: [...history.items, ...context.messages],
      onUnprocessedFileUpload: createChatKitAttachmentFilePartHandler(
        client,
        context,
      ),
    });

    const provider = modelProvider();
    const result = streamText({
      model: provider(process.env.MODEL_NAME || "gpt-5.4"),
      system:
        "You are a friendly agent. Be concise, warm, and helpful. If the user asks you to test queueing, steering, interruption, or hanging behavior, call the hangUntilAbort tool.",
      messages: await convertToModelMessages(messages),
      tools: {
        hangUntilAbort: tool({
          description:
            "Indefinitely hangs until the request abort signal is interrupted. Use only when explicitly asked to test Mission Control queue, steer, or abort behavior.",
          inputSchema: jsonSchema({
            type: "object",
            properties: {},
            additionalProperties: false,
          }),
          execute: async (_input: Record<string, never>, { abortSignal }) => {
            if (!abortSignal) {
              throw new Error("hangUntilAbort requires an abort signal");
            }
            console.info("hangUntilAbort tool started");
            await waitForAbort(abortSignal);
          },
        }),
      },
      abortSignal: request.signal,
      onAbort() {
        console.info("ChatKit agent LLM stream aborted");
      },
    });

    return result.toUIMessageStreamResponse({
      consumeSseStream: consumeStream,
    });
  },
});
