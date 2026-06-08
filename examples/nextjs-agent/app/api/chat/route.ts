import { type AgentRequestBody, runAgent } from "@/lib/agent";

export const maxDuration = 60;

export async function POST(request: Request) {
  const body = (await request.json()) as AgentRequestBody;
  return runAgent(body);
}
