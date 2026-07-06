import {
  type ChatKitContextClient,
  type ChatKitConvertedMessage,
  runWithChatKitContext,
} from "./chatkit-context";
import { type ChatKitMessage, isChatKitMessage } from "./chatkit-message";
import { type Client, type Config, createClient } from "./client";
import {
  type VerifiedWebhookRequest,
  type VerifyWebhookOptions,
  verifyWebhookRequest,
  WebhookVerificationError,
} from "./webhook";

const TILDE_ORG_ID_HEADER = "x-tilde-org-id";
const TILDE_TEAM_ID_HEADER = "x-tilde-team-id";
const TILDE_SESSION_ID_HEADER = "x-tilde-session-id";

export type { ChatKitContextClient, ChatKitConvertedMessage };

export type ChatKitSessionHistoryOptions = {
  nextPageToken?: string;
  pageSize?: number;
};

export type ChatKitSessionHistory = {
  items: ChatKitMessage[];
  nextPageToken?: string;
};

export type ChatKitSessionClient = {
  id: string;
  history(
    options?: ChatKitSessionHistoryOptions,
  ): Promise<ChatKitSessionHistory>;
};

export type ChatKitEndpointContext = {
  rawBody: Uint8Array;
  body: unknown;
  webhookId: string;
  timestamp: number;
  orgId: string;
  teamId: string;
  sessionId: string;
  client: Client;
  session: ChatKitSessionClient;
  chatkit: ChatKitContextClient;
};

export type ChatKitEndpointOptions = VerifyWebhookOptions & {
  client?: Partial<Config>;
  handler: (
    request: Request,
    context: ChatKitEndpointContext,
  ) => Response | Promise<Response>;
};

export function chatKitEndpoint(
  options: ChatKitEndpointOptions,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    let verified: VerifiedWebhookRequest;
    try {
      verified = await verifyWebhookRequest(request.clone(), options);
    } catch (error) {
      const status =
        error instanceof WebhookVerificationError &&
        error.message === "Invalid JSON body"
          ? 400
          : 401;
      return new Response(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Invalid webhook",
        }),
        {
          status,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    const orgId = requiredHeader(request.headers, TILDE_ORG_ID_HEADER);
    const teamId = requiredHeader(request.headers, TILDE_TEAM_ID_HEADER);
    const sessionId = requiredHeader(request.headers, TILDE_SESSION_ID_HEADER);
    if (!orgId.ok) {
      return jsonError(400, orgId.error);
    }
    if (!teamId.ok) {
      return jsonError(400, teamId.error);
    }
    if (!sessionId.ok) {
      return jsonError(400, sessionId.error);
    }

    const client = createClient(
      resolveClientConfig(options.client, orgId.value, teamId.value),
    );
    const currentRequestMessageIds = messageIdsFromRequestBody(verified.json);
    const session: ChatKitSessionClient = {
      id: sessionId.value,
      async history(historyOptions = {}) {
        if (
          historyOptions.pageSize === undefined &&
          historyOptions.nextPageToken === undefined
        ) {
          const items: unknown[] = [];
          let nextPageToken: string | undefined;
          do {
            const input: {
              sessionId: string;
              pageSize: number;
              nextPageToken?: string;
            } = {
              sessionId: sessionId.value,
              pageSize: 100,
            };
            if (nextPageToken !== undefined) {
              input.nextPageToken = nextPageToken;
            }
            const page = await client.chatkit.listMessageHistory(input);
            items.push(...page.items);
            nextPageToken = page.nextPageToken;
          } while (nextPageToken);
          return {
            items: normalizeHistoryItems(items, currentRequestMessageIds),
          };
        }

        const input: {
          sessionId: string;
          pageSize?: number;
          nextPageToken?: string;
        } = {
          sessionId: sessionId.value,
        };
        if (historyOptions.pageSize !== undefined) {
          input.pageSize = historyOptions.pageSize;
        }
        if (historyOptions.nextPageToken !== undefined) {
          input.nextPageToken = historyOptions.nextPageToken;
        }
        const history = await client.chatkit.listMessageHistory(input);
        return {
          ...history,
          items: normalizeHistoryItems(history.items, currentRequestMessageIds),
        };
      },
    };
    const chatkit: ChatKitContextClient = {
      cacheConvertedMessages(input) {
        return client.chatkit.cacheConvertedMessages(input);
      },
      hydrateConvertedMessages(input) {
        return client.chatkit.hydrateConvertedMessages(input);
      },
    };

    const forwarded = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: verified.rawBody,
      signal: request.signal,
      duplex: "half",
    } as RequestInit);

    const context: ChatKitEndpointContext = {
      rawBody: verified.rawBody,
      body: verified.json,
      webhookId: verified.webhookId,
      timestamp: verified.timestamp,
      orgId: orgId.value,
      teamId: teamId.value,
      sessionId: sessionId.value,
      client,
      session,
      chatkit,
    };

    return runWithChatKitContext(chatkit, () =>
      options.handler(forwarded, context),
    );
  };
}

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function requiredHeader(
  headers: Headers,
  name: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const value = headers.get(name)?.trim();
  if (!value) {
    return { ok: false, error: `Missing ${name} header` };
  }
  return { ok: true, value };
}

function resolveClientConfig(
  overrides: Partial<Config> | undefined,
  orgId: string,
  teamId: string,
): Config {
  const config: Config = {
    orgId,
    teamId,
  };
  assignIfDefined(
    config,
    "baseUrl",
    overrides?.baseUrl ?? env("TILDE_BASE_URL"),
  );
  assignIfDefined(
    config,
    "baseApiUrl",
    overrides?.baseApiUrl ?? env("TILDE_BASE_API_URL"),
  );
  assignIfDefined(config, "apiKey", overrides?.apiKey ?? env("TILDE_API_KEY"));
  assignIfDefined(
    config,
    "bearerToken",
    overrides?.bearerToken ?? env("TILDE_BEARER_TOKEN"),
  );
  assignIfDefined(config, "fetch", overrides?.fetch);
  assignIfDefined(config, "headers", overrides?.headers);
  return config;
}

function assignIfDefined<Key extends keyof Config>(
  config: Config,
  key: Key,
  value: Config[Key] | undefined,
) {
  if (value !== undefined) {
    config[key] = value;
  }
}

function env(name: string): string | undefined {
  if (typeof process === "undefined") {
    return undefined;
  }
  return process.env[name];
}

function messageIdsFromRequestBody(body: unknown): Set<string> {
  if (!isRecord(body) || !Array.isArray(body.messages)) return new Set();
  const ids = body.messages
    .map(messageId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return new Set(ids);
}

function messageId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return typeof value.id === "string" ? value.id : null;
}

function normalizeHistoryItems(
  items: unknown[],
  currentRequestMessageIds: Set<string>,
): ChatKitMessage[] {
  const normalized = items
    .filter(isChatKitMessage)
    .sort(compareChatKitMessagesByCreatedAt);
  if (currentRequestMessageIds.size === 0) return normalized;
  return normalized.filter((item) => {
    const id = messageId(item);
    return !id || !currentRequestMessageIds.has(id);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function compareChatKitMessagesByCreatedAt(
  left: ChatKitMessage,
  right: ChatKitMessage,
): number {
  if (!left.created_at || !right.created_at) return 0;
  return left.created_at.localeCompare(right.created_at);
}
