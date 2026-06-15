import type { Config } from "../config";
import { requestJson } from "../internal/fetch-client";
import { buildUrl, pathWithParams, teamPath } from "../internal/paths";
import { MessagesClient } from "./messages";

const REGISTER_HTTP_AGENT_PATH =
  "/api/v1/team/{team_id}/chatkit/agents/http-vercel-ai-sdk";
const REGISTER_VERCEL_UI_CHANNEL_PATH =
  "/api/v1/team/{team_id}/chatkit/channels/vercel-ui";
const MESSAGE_HISTORY_PATH =
  "/api/v1/team/{team_id}/chatkit/sessions/{session_id}/messages";

type Paginated<T> = {
  items: T[];
  next_page_token?: string | null;
};

export class ChatKitClient {
  readonly #config: Config;
  readonly #messages: MessagesClient;

  constructor(config: Config, messages = new MessagesClient(config)) {
    this.#config = config;
    this.#messages = messages;
  }

  async registerHttpVercelAiSdkAgent(input: {
    id?: string;
    displayName: string;
    endpointUrl: string;
    streaming?: boolean;
    timeoutMs?: number;
  }): Promise<{
    agent: unknown;
    apiKey: string;
    webhookSigningKey: string;
  }> {
    const raw = await requestJson<{
      agent: unknown;
      api_key: string;
      webhook_signing_key: string;
    }>(this.#config, {
      method: "POST",
      path: teamPath(this.#config, REGISTER_HTTP_AGENT_PATH),
      body: {
        id: input.id,
        display_name: input.displayName,
        endpoint_url: input.endpointUrl,
        streaming: input.streaming ?? false,
        timeout_ms: input.timeoutMs,
      },
    });
    return {
      agent: raw.agent,
      apiKey: raw.api_key,
      webhookSigningKey: raw.webhook_signing_key,
    };
  }

  async registerVercelUiChannel(input: {
    id?: string;
    displayName: string;
    defaultAgentInboxId?: string;
  }): Promise<unknown> {
    return requestJson<unknown>(this.#config, {
      method: "POST",
      path: teamPath(this.#config, REGISTER_VERCEL_UI_CHANNEL_PATH),
      body: {
        id: input.id,
        display_name: input.displayName,
        default_agent_inbox_id: input.defaultAgentInboxId,
      },
    });
  }

  async listMessageHistory(input: {
    sessionId: string;
    pageSize?: number;
    nextPageToken?: string;
    channelId?: string;
    participantInboxId?: string;
    externalUserId?: string;
  }): Promise<{ items: unknown[]; nextPageToken?: string }> {
    try {
      const raw = await requestJson<Paginated<unknown>>(this.#config, {
        path: pathWithParams(teamPath(this.#config, MESSAGE_HISTORY_PATH), {
          session_id: input.sessionId,
        }),
        query: {
          page_size: input.pageSize ?? 100,
          next_page_token: input.nextPageToken,
          channel_id: input.channelId,
          participant_inbox_id: input.participantInboxId,
          external_user_id: input.externalUserId,
        },
      });
      const result: { items: unknown[]; nextPageToken?: string } = {
        items: raw.items,
      };
      if (raw.next_page_token) {
        result.nextPageToken = raw.next_page_token;
      }
      return result;
    } catch (error) {
      if (isMissingChatKitRoute(error)) {
        return this.#messages.list(input);
      }
      throw error;
    }
  }

  vercelUiEndpoint(input: {
    sessionId: string;
    inboxId: string;
    instanceId: string;
    stream?: boolean;
  }): string {
    const suffix = input.stream ? "/ai/ui/stream" : "/ai/ui";
    return buildUrl(
      this.#config,
      `/api/v1/team/${encodeURIComponent(this.#config.teamId)}/inbox/session/${encodeURIComponent(input.sessionId)}/inbox/${encodeURIComponent(input.inboxId)}/instance/${encodeURIComponent(input.instanceId)}${suffix}`,
    );
  }
}

export { MessagesClient } from "./messages";

function isMissingChatKitRoute(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error.status === 404 || error.status === 405)
  );
}
