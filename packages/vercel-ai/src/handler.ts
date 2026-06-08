import {
  type VerifiedWebhookRequest,
  type VerifyWebhookOptions,
  verifyWebhookRequest,
  WebhookVerificationError,
} from "./webhook";

export type ChatKitEndpointContext = {
  rawBody: Uint8Array;
  body: unknown;
  webhookId: string;
  timestamp: number;
};

export type ChatKitEndpointOptions = VerifyWebhookOptions & {
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
    });
  };
}
