import {
  type ChatKitContextClient,
  type ChatKitConvertedMessage,
  runWithChatKitContext,
} from "./chatkit-context";
import { type ChatKitMessage, isChatKitMessage } from "./chatkit-message";
import type { JsonObject, JsonValue } from "@tilde/harness-sdk";
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
  body: JsonValue;
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
  logger?: ChatKitEndpointLogger | false;
  handler: (
    request: Request,
    context: ChatKitEndpointContext,
  ) => Response | Promise<Response>;
};

export type ChatKitEndpointLogLevel = "info" | "warn" | "error";

export type ChatKitEndpointLogger = (
  level: ChatKitEndpointLogLevel,
  message: string,
  fields: JsonObject,
) => void;

export function chatKitEndpoint(
  options: ChatKitEndpointOptions,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const log = endpointLogger(options.logger);
    const baseFields = {
      requestId,
      method: request.method,
      url: request.url,
    };
    log("info", "request received", baseFields);

    let verified: VerifiedWebhookRequest;
    try {
      verified = await verifyWebhookRequest(request.clone(), options);
      log("info", "webhook verified", {
        ...baseFields,
        webhookId: verified.webhookId,
        timestamp: verified.timestamp,
        elapsedMs: elapsedMs(startedAt),
      });
    } catch (error) {
      const status =
        error instanceof WebhookVerificationError &&
        error.message === "Invalid JSON body"
          ? 400
          : 401;
      log("warn", "webhook verification failed", {
        ...baseFields,
        status,
        elapsedMs: elapsedMs(startedAt),
        error: error instanceof Error ? error.message : "Invalid webhook",
      });
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
      log("warn", "request rejected", {
        ...baseFields,
        status: 400,
        error: orgId.error,
        elapsedMs: elapsedMs(startedAt),
      });
      return jsonError(400, orgId.error);
    }
    if (!teamId.ok) {
      log("warn", "request rejected", {
        ...baseFields,
        status: 400,
        error: teamId.error,
        elapsedMs: elapsedMs(startedAt),
      });
      return jsonError(400, teamId.error);
    }
    if (!sessionId.ok) {
      log("warn", "request rejected", {
        ...baseFields,
        status: 400,
        error: sessionId.error,
        elapsedMs: elapsedMs(startedAt),
      });
      return jsonError(400, sessionId.error);
    }

    const requestFields = {
      ...baseFields,
      webhookId: verified.webhookId,
      orgId: orgId.value,
      teamId: teamId.value,
      sessionId: sessionId.value,
    };
    log("info", "context resolved", {
      ...requestFields,
      requestMessageCount: requestMessageCount(verified.json),
      requestMessageIds: messageIdsFromRequestBody(verified.json).size,
    });

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
          const items: JsonValue[] = [];
          let nextPageToken: string | undefined;
          do {
            const historyStartedAt = Date.now();
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
            log("info", "session history page requested", {
              ...requestFields,
              pageSize: input.pageSize,
              hasNextPageToken: Boolean(input.nextPageToken),
            });
            const page = await client.chatkit.listMessageHistory<JsonValue>(input);
            items.push(...page.items);
            nextPageToken = page.nextPageToken;
            log("info", "session history page received", {
              ...requestFields,
              pageItemCount: page.items.length,
              totalItemCount: items.length,
              hasNextPage: Boolean(nextPageToken),
              elapsedMs: elapsedMs(historyStartedAt),
            });
          } while (nextPageToken);
          const normalized = normalizeHistoryItems(items, currentRequestMessageIds);
          log("info", "session history completed", {
            ...requestFields,
            rawItemCount: items.length,
            normalizedItemCount: normalized.length,
          });
          return {
            items: normalized,
          };
        }

        const historyStartedAt = Date.now();
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
        log("info", "session history page requested", {
          ...requestFields,
          pageSize: input.pageSize,
          hasNextPageToken: Boolean(input.nextPageToken),
        });
        const history = await client.chatkit.listMessageHistory<JsonValue>(input);
        const normalized = normalizeHistoryItems(history.items, currentRequestMessageIds);
        log("info", "session history page received", {
          ...requestFields,
          pageItemCount: history.items.length,
          normalizedItemCount: normalized.length,
          hasNextPage: Boolean(history.nextPageToken),
          elapsedMs: elapsedMs(historyStartedAt),
        });
        return {
          ...history,
          items: normalized,
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

    try {
      const response = await runWithChatKitContext(chatkit, () =>
        options.handler(forwarded, context),
      );
      log("info", "handler completed", {
        ...requestFields,
        status: response.status,
        elapsedMs: elapsedMs(startedAt),
      });
      return response;
    } catch (error) {
      log("error", "handler failed", {
        ...requestFields,
        elapsedMs: elapsedMs(startedAt),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}

function endpointLogger(logger: ChatKitEndpointOptions["logger"]): ChatKitEndpointLogger {
  if (logger === false) {
    return () => {};
  }
  if (logger) {
    return logger;
  }
  return (level, message, fields) => {
    const payload = {
      ts: new Date().toISOString(),
      level,
      scope: "chatkit-endpoint",
      message,
      ...fields,
    };
    const line = `[tilde-chatkit] ${JSON.stringify(payload)}`;
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  };
}

function elapsedMs(startedAt: number): number {
  return Date.now() - startedAt;
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

function messageIdsFromRequestBody(body: JsonValue): Set<string> {
  if (!isRecord(body) || !Array.isArray(body.messages)) return new Set();
  const ids = body.messages
    .map(messageId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return new Set(ids);
}

function requestMessageCount(body: JsonValue): number {
  if (!isRecord(body) || !Array.isArray(body.messages)) return 0;
  return body.messages.length;
}

function messageId(value: JsonValue): string | null {
  if (!isRecord(value)) return null;
  return typeof value.id === "string" ? value.id : null;
}

function normalizeHistoryItems(
  items: JsonValue[],
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

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

function compareChatKitMessagesByCreatedAt(
  left: ChatKitMessage,
  right: ChatKitMessage,
): number {
  if (!left.created_at || !right.created_at) return 0;
  return left.created_at.localeCompare(right.created_at);
}
