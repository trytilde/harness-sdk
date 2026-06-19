import {
  type Client,
  type Config,
  createClient,
} from "./client";
import {
  type VerifiedWebhookRequest,
  type VerifyWebhookOptions,
  verifyWebhookRequest,
  WebhookVerificationError,
} from "./webhook";

const TILDE_ORG_ID_HEADER = "x-tilde-org-id";
const TILDE_TEAM_ID_HEADER = "x-tilde-team-id";
const TILDE_SESSION_ID_HEADER = "x-tilde-session-id";

export type ChatKitSessionHistoryOptions = {
  nextPageToken?: string;
  pageSize?: number;
};

export type ChatKitSessionHistory = {
  items: unknown[];
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
    const session: ChatKitSessionClient = {
      id: sessionId.value,
      history(historyOptions = {}) {
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
        return client.chatkit.listMessageHistory(input);
      },
    };

    const forwarded = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: verified.rawBody,
      duplex: "half",
    } as RequestInit);

    return options.handler(forwarded, {
      rawBody: verified.rawBody,
      body: verified.json,
      webhookId: verified.webhookId,
      timestamp: verified.timestamp,
      orgId: orgId.value,
      teamId: teamId.value,
      sessionId: sessionId.value,
      client,
      session,
    });
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
  assignIfDefined(config, "baseUrl", overrides?.baseUrl ?? env("TILDE_BASE_URL"));
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
