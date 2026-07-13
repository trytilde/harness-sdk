import type { NormalizedConfig } from "../config";
import { requestJson } from "../internal/fetch-client";
import { buildUrl, pathWithParams, teamPath } from "../internal/paths";
import type { JsonObject, JsonValue } from "../tools";
import { MessagesClient } from "./messages";

const REGISTER_HTTP_AGENT_PATH =
  "/api/v1/team/{team_id}/chatkit/agents/http-vercel-ai-sdk";
const REGISTER_VERCEL_UI_CHANNEL_PATH =
  "/api/v1/team/{team_id}/chatkit/channels/vercel-ui";
const MESSAGE_HISTORY_PATH =
  "/api/v1/team/{team_id}/chatkit/sessions/{session_id}/messages";
const CONVERTED_MESSAGE_CACHE_PATH =
  "/api/v1/team/{team_id}/chatkit/messages/converted-cache";
const HYDRATE_CONVERTED_MESSAGE_CACHE_PATH =
  "/api/v1/team/{team_id}/chatkit/messages/converted-cache/hydrate";
const ATTACHMENT_DOWNLOAD_URL_PATH =
  "/api/v1/team/{team_id}/chatkit/session/{session_id}/attachment/{attachment_id}/download-url";

type Paginated<T> = {
  items: T[];
  next_page_token?: string | null;
};

export type ConvertedChatKitMessage = {
  chatKitMessageId: string;
  message: JsonObject;
};

export type RegisteredChatKitAgent = JsonObject & {
  id?: string;
  display_name?: string;
  endpoint_url?: string;
};

export type RegisteredChatKitChannel = JsonObject & {
  id?: string;
  display_name?: string;
};

export type ChatKitAttachment = JsonObject & {
  id?: string;
  filename?: string;
  media_type?: string;
};

export class ChatKitClient {
  readonly #config: NormalizedConfig;
  readonly #messages: MessagesClient;

  constructor(config: NormalizedConfig, messages = new MessagesClient(config)) {
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
    agent: RegisteredChatKitAgent;
    apiKey: string;
    webhookSigningKey: string;
  }> {
    const raw = await requestJson<{
      agent: RegisteredChatKitAgent;
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

  async registerVercelUiChannel<
    TResult extends RegisteredChatKitChannel = RegisteredChatKitChannel,
  >(input: {
    id?: string;
    displayName: string;
    defaultAgentInboxId?: string;
  }): Promise<TResult> {
    return requestJson<TResult>(this.#config, {
      method: "POST",
      path: teamPath(this.#config, REGISTER_VERCEL_UI_CHANNEL_PATH),
      body: {
        id: input.id,
        display_name: input.displayName,
        default_agent_inbox_id: input.defaultAgentInboxId,
      },
    });
  }

  async listMessageHistory<TMessage extends JsonValue = JsonObject>(input: {
    sessionId: string;
    pageSize?: number;
    nextPageToken?: string;
    channelId?: string;
    participantInboxId?: string;
    externalUserId?: string;
  }): Promise<{ items: TMessage[]; nextPageToken?: string }> {
    try {
      const raw = await requestJson<Paginated<TMessage>>(this.#config, {
        path: pathWithParams(teamPath(this.#config, MESSAGE_HISTORY_PATH), {
          session_id: input.sessionId,
        }),
        query: {
          page_size: input.pageSize ?? 100,
          next_page_token: input.nextPageToken,
          channel_id: input.channelId,
          participant_inbox_id: input.participantInboxId,
          user_external_id: input.externalUserId,
        },
      });
      const result: { items: TMessage[]; nextPageToken?: string } = {
        items: raw.items,
      };
      if (raw.next_page_token) {
        result.nextPageToken = raw.next_page_token;
      }
      return result;
    } catch (error) {
      if (isMissingChatKitRoute(error)) {
        return this.#messages.list<TMessage>(input);
      }
      throw error;
    }
  }

  async cacheConvertedMessages(input: {
    messages: ConvertedChatKitMessage[];
  }): Promise<{ success: boolean }> {
    const raw = await requestJson<{ success: boolean }>(this.#config, {
      method: "POST",
      path: teamPath(this.#config, CONVERTED_MESSAGE_CACHE_PATH),
      body: {
        messages: input.messages.map((message) => ({
          chatkit_message_id: message.chatKitMessageId,
          message: message.message,
        })),
      },
    });
    return { success: raw.success };
  }

  async hydrateConvertedMessages(input: {
    messageIds: string[];
  }): Promise<{ messages: ConvertedChatKitMessage[] }> {
    const raw = await requestJson<{
      messages: {
        chatkit_message_id: string;
        message: JsonObject;
      }[];
    }>(this.#config, {
      method: "POST",
      path: teamPath(this.#config, HYDRATE_CONVERTED_MESSAGE_CACHE_PATH),
      body: {
        message_ids: input.messageIds,
      },
    });
    return {
      messages: raw.messages.map((message) => ({
        chatKitMessageId: message.chatkit_message_id,
        message: message.message,
      })),
    };
  }

  async getAttachmentDownloadUrl(input: {
    sessionId: string;
    attachmentId: string;
  }): Promise<{
    attachment: ChatKitAttachment;
    downloadUrl: string;
    expiresAt: string;
  }> {
    const raw = await requestJson<{
      attachment: ChatKitAttachment;
      download_url: string;
      expires_at: string;
    }>(this.#config, {
      path: pathWithParams(
        teamPath(this.#config, ATTACHMENT_DOWNLOAD_URL_PATH),
        {
          session_id: input.sessionId,
          attachment_id: input.attachmentId,
        },
      ),
    });
    return {
      attachment: raw.attachment,
      downloadUrl: raw.download_url,
      expiresAt: raw.expires_at,
    };
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
