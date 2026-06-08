import { chatKitEndpoint } from "@tilde/harness-sdk-vercel";
import { type AgentRequestBody, runAgent } from "@/lib/agent";

export const maxDuration = 60;

export const POST = chatKitEndpoint({
  webhookSigningKey: process.env.TILDE_CHATKIT_WEBHOOK_SIGNING_KEY || "",
  async handler(_request, context) {
    return runAgent(context.body as AgentRequestBody);
  },
});
