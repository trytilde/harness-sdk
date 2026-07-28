import { describe, expect, it, vi } from "vitest";
import {
  type ChatKitEndpointOptions,
  type Config,
  chatKitEndpoint,
  convertToAiSdkMessage,
  convertToAiSdkMessages,
  createClient,
  signBody,
  TILDE_WEBHOOK_ID_HEADER,
  TILDE_WEBHOOK_SIGNATURE_HEADER,
  TILDE_WEBHOOK_TIMESTAMP_HEADER,
  verifyWebhookRequest,
} from "../src";

const key = "whsec--test";

function testChatKitEndpoint(
  options: Omit<ChatKitEndpointOptions, "client"> & {
    client?: Config;
  },
) {
  const { client: clientConfig, ...endpointOptions } = options;
  return chatKitEndpoint({
    ...endpointOptions,
    client: createClient({
      apiKey: "test-key",
      orgId: "org-123",
      teamId: "team_123",
      ...clientConfig,
    }),
  });
}

function signedRequest(
  body: unknown,
  timestamp = Math.floor(Date.now() / 1000),
  contextHeaders: Record<string, string> = {
    "x-tilde-org-id": "org-123",
    "x-tilde-team-id": "team_123",
    "x-tilde-session-id": "session_1",
    "x-tilde-user-id": "user_123",
    "x-external-user-id": "U123",
    "x-external-user-provider": "slack",
  },
) {
  const raw = new TextEncoder().encode(JSON.stringify(body));
  return new Request("https://example.test/webhook", {
    method: "POST",
    headers: {
      [TILDE_WEBHOOK_ID_HEADER]: "webhook-123",
      [TILDE_WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
      [TILDE_WEBHOOK_SIGNATURE_HEADER]: signBody(key, timestamp, raw),
      ...contextHeaders,
      "Content-Type": "application/json",
    },
    body: raw,
    duplex: "half",
  } as RequestInit);
}

describe("verifyWebhookRequest", () => {
  it("accepts a valid signature", async () => {
    const verified = await verifyWebhookRequest(signedRequest({ ok: true }), {
      webhookSigningKey: key,
    });

    expect(verified.webhookId).toBe("webhook-123");
    expect(verified.json).toEqual({ ok: true });
  });

  it("rejects missing headers", async () => {
    await expect(
      verifyWebhookRequest(
        new Request("https://example.test", { method: "POST", body: "{}" }),
        { webhookSigningKey: key },
      ),
    ).rejects.toThrow("Missing x-tilde-webhook-id header");
  });

  it("rejects stale timestamps", async () => {
    await expect(
      verifyWebhookRequest(signedRequest({ ok: true }, 1), {
        webhookSigningKey: key,
      }),
    ).rejects.toThrow("Webhook timestamp is outside tolerance");
  });

  it("rejects wrong signatures", async () => {
    const request = signedRequest({ ok: true });
    request.headers.set(TILDE_WEBHOOK_SIGNATURE_HEADER, "hmac-sha256=deadbeef");

    await expect(
      verifyWebhookRequest(request, { webhookSigningKey: key }),
    ).rejects.toThrow("Invalid webhook signature");
  });
});

describe("chatKitEndpoint", () => {
  it("reconstructs the request body after verification", async () => {
    const handler = vi.fn(async (request: Request, context) => {
      expect(context.body).toEqual({ messages: [] });
      expect(context.messages).toEqual([]);
      expect(await request.json()).toEqual({ messages: [] });
      expect(context.orgId).toBe("org-123");
      expect(context.teamId).toBe("team_123");
      expect(context.sessionId).toBe("session_1");
      expect(context.userId).toBe("user_123");
      expect(context.externalUserId).toBe("U123");
      expect(context.externalUserProvider).toBe("slack");
      expect(context.skills).toBeDefined();
      expect(context.session.id).toBe("session_1");
      return new Response("ok");
    });

    const endpoint = testChatKitEndpoint({
      webhookSigningKey: key,
      client: {
        apiKey: "test-key",
      },
      handler,
    });

    const response = await endpoint(signedRequest({ messages: [] }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("provides validated Tilde request messages to the handler", async () => {
    const messages = [
      {
        id: "message-1",
        role: "user",
        parts: [
          { type: "text", text: "hello" },
          {
            type: "file",
            mediaType: "image/png",
            filename: "image.png",
            url: "https://example.test/image.png",
          },
          {
            type: "dynamic-tool",
            toolCallId: "tool-1",
            toolName: "lookup",
            state: "output-available",
            input: { query: "hello" },
            output: { ok: true },
          },
          {
            type: "source-url",
            sourceId: "source-1",
            url: "https://example.test/source",
          },
          {
            type: "source-document",
            sourceId: "document-1",
            mediaType: "text/plain",
          },
          { type: "step-start" },
          { type: "data", dataType: "tilde.signal", data: { value: 1 } },
        ],
      },
    ];
    const handler = vi.fn(async (_request: Request, context) => {
      expect(context.messages).toEqual(messages);
      return new Response("ok");
    });
    const endpoint = testChatKitEndpoint({
      webhookSigningKey: key,
      client: { apiKey: "test-key" },
      handler,
    });

    const response = await endpoint(signedRequest({ messages }));

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each([
    [{}, "body.messages must be an array"],
    [
      { messages: [{ id: "message-1", role: "invalid", parts: [] }] },
      "body.messages[0].role",
    ],
    [
      {
        messages: [
          {
            id: "message-1",
            role: "user",
            parts: [{ type: "file", url: "https://example.test/file" }],
          },
        ],
      },
      "body.messages[0].parts[0].mediaType",
    ],
    [
      {
        messages: [
          {
            id: "message-1",
            role: "user",
            parts: [{ type: "unsupported" }],
          },
        ],
      },
      "body.messages[0].parts[0].type",
    ],
  ])("rejects an invalid ChatKit request body", async (body, error) => {
    const handler = vi.fn(async () => new Response("ok"));
    const endpoint = testChatKitEndpoint({
      webhookSigningKey: key,
      client: { apiKey: "test-key" },
      handler,
    });

    const response = await endpoint(signedRequest(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: expect.stringContaining(error),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("loads session history through the typed session client", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://org-123.api.example.test/api/v1/team/team_123/chatkit/sessions/session_1/messages?page_size=10&next_page_token=next",
        );
        expect(new Headers(init?.headers).has("x-tilde-org-id")).toBe(false);
        return Response.json({
          items: [
            {
              id: "msg_2",
              role: "assistant",
              type: "text",
              text: "there",
              created_at: "2026-07-04T13:00:02Z",
            },
            {
              id: "msg_1",
              role: "user",
              type: "text",
              text: "hello",
              created_at: "2026-07-04T13:00:01Z",
            },
          ],
          next_page_token: "older",
        });
      },
    );
    const handler = vi.fn(async (_request: Request, context) => {
      await expect(
        context.session.history({ pageSize: 10, nextPageToken: "next" }),
      ).resolves.toEqual({
        items: [
          {
            id: "msg_1",
            role: "user",
            type: "text",
            text: "hello",
            created_at: "2026-07-04T13:00:01Z",
          },
          {
            id: "msg_2",
            role: "assistant",
            type: "text",
            text: "there",
            created_at: "2026-07-04T13:00:02Z",
          },
        ],
        nextPageToken: "older",
      });
      return new Response("ok");
    });

    const endpoint = testChatKitEndpoint({
      webhookSigningKey: key,
      client: {
        baseUrl: "https://api.example.test",
        apiKey: "test-key",
        fetch: fetchMock as typeof fetch,
      },
      handler,
    });

    const response = await endpoint(signedRequest({ messages: [] }));
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("preserves a non-subdomain tunnel base URL for session history", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://example.ngrok-free.app/api/v1/team/team_123/chatkit/sessions/session_1/messages?page_size=10",
        );
        expect(new Headers(init?.headers).get("x-tilde-org-id")).toBe(
          "org-123",
        );
        return Response.json({ items: [] });
      },
    );
    const endpoint = testChatKitEndpoint({
      webhookSigningKey: key,
      client: {
        baseUrl: "https://example.ngrok-free.app",
        orgSubdomain: false,
        apiKey: "test-key",
        fetch: fetchMock as typeof fetch,
      },
      handler: async (_request, context) => {
        await context.session.history({ pageSize: 10 });
        return new Response("ok");
      },
    });

    const response = await endpoint(signedRequest({ messages: [] }));
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps unresolved external identity optional", async () => {
    const handler = vi.fn(async (_request: Request, context) => {
      expect(context.userId).toBeUndefined();
      expect(context.externalUserId).toBeUndefined();
      expect(context.externalUserProvider).toBeUndefined();
      return new Response("ok");
    });
    const endpoint = testChatKitEndpoint({
      webhookSigningKey: key,
      client: { apiKey: "test-key" },
      handler,
    });

    const response = await endpoint(
      signedRequest({ messages: [] }, Math.floor(Date.now() / 1000), {
        "x-tilde-org-id": "org-123",
        "x-tilde-team-id": "team_123",
        "x-tilde-session-id": "session_1",
      }),
    );

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("loads full session history when no pagination params are passed", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("page_size=100")) {
        return Response.json({
          items: [
            {
              id: "msg_3",
              role: "assistant",
              type: "text",
              text: "third",
              created_at: "2026-07-04T13:00:03Z",
            },
            {
              id: "current_msg",
              role: "user",
              type: "text",
              text: "current",
              created_at: "2026-07-04T13:00:04Z",
            },
          ],
          next_page_token: "older",
        });
      }
      expect(url).toBe(
        "https://org-123.api.example.test/api/v1/team/team_123/chatkit/sessions/session_1/messages?page_size=100&next_page_token=older",
      );
      return Response.json({
        items: [
          {
            id: "msg_1",
            role: "user",
            type: "text",
            text: "first",
            created_at: "2026-07-04T13:00:01Z",
          },
          {
            id: "msg_2",
            role: "assistant",
            type: "text",
            text: "second",
            created_at: "2026-07-04T13:00:02Z",
          },
        ],
      });
    });
    const handler = vi.fn(async (_request: Request, context) => {
      await expect(context.session.history()).resolves.toEqual({
        items: [
          {
            id: "msg_1",
            role: "user",
            type: "text",
            text: "first",
            created_at: "2026-07-04T13:00:01Z",
          },
          {
            id: "msg_2",
            role: "assistant",
            type: "text",
            text: "second",
            created_at: "2026-07-04T13:00:02Z",
          },
          {
            id: "msg_3",
            role: "assistant",
            type: "text",
            text: "third",
            created_at: "2026-07-04T13:00:03Z",
          },
        ],
      });
      return new Response("ok");
    });

    const endpoint = testChatKitEndpoint({
      webhookSigningKey: key,
      client: {
        baseUrl: "https://api.example.test",
        apiKey: "test-key",
        fetch: fetchMock as typeof fetch,
      },
      handler,
    });

    const response = await endpoint(
      signedRequest({
        messages: [{ id: "current_msg", role: "user", parts: [] }],
      }),
    );
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("excludes current request message ids from session history", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        items: [
          { id: "current_msg", role: "user", type: "text", text: "current" },
          {
            id: "previous_msg",
            role: "assistant",
            type: "text",
            text: "previous",
          },
        ],
      }),
    );
    const handler = vi.fn(async (_request: Request, context) => {
      await expect(context.session.history()).resolves.toEqual({
        items: [
          {
            id: "previous_msg",
            role: "assistant",
            type: "text",
            text: "previous",
          },
        ],
      });
      return new Response("ok");
    });

    const endpoint = testChatKitEndpoint({
      webhookSigningKey: key,
      client: {
        baseUrl: "https://api.example.test",
        apiKey: "test-key",
        fetch: fetchMock as typeof fetch,
      },
      handler,
    });

    const response = await endpoint(
      signedRequest({
        messages: [{ id: "current_msg", role: "user", parts: [] }],
      }),
    );
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("caches converted messages in one batch by default inside a ChatKit endpoint handler", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://org-123.api.example.test/api/v1/team/team_123/chatkit/messages/converted-cache",
        );
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          messages: [
            {
              chatkit_message_id: "msg_1",
              message: {
                id: "msg_1",
                role: "user",
                parts: [{ type: "text", text: "hello" }],
                metadata: {
                  chatkit: {},
                },
              },
            },
            {
              chatkit_message_id: "msg_2",
              message: {
                id: "msg_2",
                role: "assistant",
                parts: [{ type: "text", text: "there" }],
                metadata: {
                  chatkit: {},
                },
              },
            },
          ],
        });
        return Response.json({ success: true });
      },
    );
    const handler = vi.fn(async () => {
      await convertToAiSdkMessages({
        messages: [
          {
            id: "msg_1",
            role: "user",
            type: "text",
            text: "hello",
          },
          {
            id: "msg_2",
            role: "assistant",
            type: "text",
            text: "there",
          },
        ],
      });
      return new Response("ok");
    });

    const endpoint = testChatKitEndpoint({
      webhookSigningKey: key,
      client: {
        baseUrl: "https://api.example.test",
        apiKey: "test-key",
        fetch: fetchMock as typeof fetch,
      },
      handler,
    });

    const response = await endpoint(signedRequest({ messages: [] }));
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses an explicit cache callback instead of the default endpoint cache", async () => {
    const fetchMock = vi.fn(async () => Response.json({ success: true }));
    const onCacheMessage = vi.fn(async () => undefined);
    const handler = vi.fn(async () => {
      await convertToAiSdkMessages({
        messages: [
          {
            id: "msg_1",
            role: "user",
            type: "text",
            text: "hello",
          },
        ],
        onCacheMessage,
      });
      return new Response("ok");
    });

    const endpoint = testChatKitEndpoint({
      webhookSigningKey: key,
      client: {
        baseUrl: "https://api.example.test",
        apiKey: "test-key",
        fetch: fetchMock as typeof fetch,
      },
      handler,
    });

    const response = await endpoint(signedRequest({ messages: [] }));
    expect(response.status).toBe(200);
    expect(onCacheMessage).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("batches explicit cache callback results", async () => {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://org-123.api.example.test/api/v1/team/team_123/chatkit/messages/converted-cache",
        );
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          messages: [
            {
              chatkit_message_id: "msg_1",
              message: { custom: "msg_1" },
            },
            {
              chatkit_message_id: "msg_2",
              message: { custom: "msg_2" },
            },
          ],
        });
        return Response.json({ success: true });
      },
    );
    const onCacheMessage = vi.fn(async ({ message }) => ({
      chatKitMessageId: message.id,
      message: { custom: message.id },
    }));
    const handler = vi.fn(async () => {
      await convertToAiSdkMessages({
        messages: [
          {
            id: "msg_1",
            role: "user",
            type: "text",
            text: "hello",
          },
          {
            id: "msg_2",
            role: "assistant",
            type: "text",
            text: "there",
          },
        ],
        onCacheMessage,
      });
      return new Response("ok");
    });

    const endpoint = testChatKitEndpoint({
      webhookSigningKey: key,
      client: {
        baseUrl: "https://api.example.test",
        apiKey: "test-key",
        fetch: fetchMock as typeof fetch,
      },
      handler,
    });

    const response = await endpoint(signedRequest({ messages: [] }));
    expect(response.status).toBe(200);
    expect(onCacheMessage).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns 400 before calling the handler when org id is missing", async () => {
    const handler = vi.fn(async () => new Response("ok"));
    const endpoint = testChatKitEndpoint({
      webhookSigningKey: key,
      handler,
    });

    const response = await endpoint(
      signedRequest({ messages: [] }, Math.floor(Date.now() / 1000), {
        "x-tilde-team-id": "team_123",
        "x-tilde-session-id": "session_1",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Missing x-tilde-org-id header",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 400 before calling the handler when team id is missing", async () => {
    const handler = vi.fn(async () => new Response("ok"));
    const endpoint = testChatKitEndpoint({
      webhookSigningKey: key,
      handler,
    });

    const response = await endpoint(
      signedRequest({ messages: [] }, Math.floor(Date.now() / 1000), {
        "x-tilde-org-id": "org-123",
        "x-tilde-session-id": "session_1",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Missing x-tilde-team-id header",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 400 before calling the handler when session id is missing", async () => {
    const handler = vi.fn(async () => new Response("ok"));
    const endpoint = testChatKitEndpoint({
      webhookSigningKey: key,
      handler,
    });

    const response = await endpoint(
      signedRequest({ messages: [] }, Math.floor(Date.now() / 1000), {
        "x-tilde-org-id": "org-123",
        "x-tilde-team-id": "team_123",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Missing x-tilde-session-id header",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 401 before calling the handler on invalid signatures", async () => {
    const handler = vi.fn(async () => new Response("ok"));
    const request = signedRequest(
      { messages: [] },
      Math.floor(Date.now() / 1000),
      {},
    );
    request.headers.set(TILDE_WEBHOOK_SIGNATURE_HEADER, "hmac-sha256=deadbeef");

    const endpoint = testChatKitEndpoint({
      webhookSigningKey: key,
      handler,
    });

    const response = await endpoint(request);
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("ChatKit AI SDK converters", () => {
  it("converts Tilde request data parts to AI SDK data parts", async () => {
    await expect(
      convertToAiSdkMessage({
        message: {
          id: "request_message",
          role: "user",
          parts: [
            { type: "text", text: "hello" },
            {
              type: "data",
              dataType: "tilde.signal",
              data: { summary: "changed" },
            },
          ],
        },
      }),
    ).resolves.toEqual({
      id: "request_message",
      role: "user",
      parts: [
        { type: "text", text: "hello" },
        {
          type: "data-tilde.signal",
          data: { summary: "changed" },
        },
      ],
    });
  });

  it("converts typed ChatKit text messages", async () => {
    await expect(
      convertToAiSdkMessage({
        message: {
          id: "msg_text",
          role: "user",
          type: "text",
          text: "hello",
          created_at: "2026-07-04T13:00:00Z",
        },
      }),
    ).resolves.toMatchObject({
      id: "msg_text",
      role: "user",
      parts: [{ type: "text", text: "hello" }],
      metadata: { createdAt: "2026-07-04T13:00:00Z" },
    });
  });

  it("uses the file upload hook for unprocessed ChatKit file parts", async () => {
    await expect(
      convertToAiSdkMessages({
        messages: [
          {
            id: "msg_file",
            role: "user",
            type: "ui",
            parts: [
              {
                type: "file",
                media_type: "image/png",
                filename: "image.png",
                url: "/download",
                provider_metadata: {
                  chatkit: { attachmentId: "attachment_1" },
                },
              },
            ],
          },
        ],
        onUnprocessedFileUpload({ part }) {
          return {
            type: "file",
            mediaType: part.media_type,
            filename: part.filename ?? undefined,
            data: { file_id: "file_123" },
          } as never;
        },
      }),
    ).resolves.toMatchObject([
      {
        id: "msg_file",
        role: "user",
        parts: [
          {
            type: "file",
            mediaType: "image/png",
            filename: "image.png",
            data: {
              file_id: "file_123",
            },
          },
        ],
      },
    ]);
  });

  it("hydrates cached agent representations before converting raw parts", async () => {
    await expect(
      convertToAiSdkMessage({
        message: {
          id: "msg_cached",
          role: "user",
          type: "ui",
          parts: [],
          cached_agent_representation: {
            id: "msg_cached",
            role: "user",
            parts: [{ type: "text", text: "cached" }],
          },
        },
      }),
    ).resolves.toMatchObject({
      id: "msg_cached",
      role: "user",
      parts: [{ type: "text", text: "cached" }],
    });
  });
});
