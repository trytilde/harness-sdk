import { agent, defineApp, tool } from "../../../packages/core/src";

export default defineApp({
  name: "tilde-e2e-dev-hosted-agent",
  agents: [
    agent({
      id: "dummy-agent",
      description: "Dummy hosted agent used by the Vercel Platforms e2e.",
    }),
  ],
  tools: [
    tool({
      id: "echo-tool",
      description: "Dummy custom tool used by the Vercel Platforms e2e.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
      },
      outputSchema: {
        type: "object",
        properties: {
          tool: { type: "string" },
          text: { type: "string" },
        },
        required: ["tool", "text"],
      },
    }),
  ],
});
