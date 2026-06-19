import { describe, expect, it, vi } from "vitest";
import {
  chatKitEndpoint,
  signBody,
  TILDE_WEBHOOK_ID_HEADER,
  TILDE_WEBHOOK_SIGNATURE_HEADER,
  TILDE_WEBHOOK_TIMESTAMP_HEADER,
  verifyWebhookRequest,
} from "../src";

const key = "whsec--test";

function signedRequest(
  body: unknown,
  timestamp = Math.floor(Date.now() / 1000),
  contextHeaders: Record<string, string> = {
    "x-tilde-org-id": "org-123",
    "x-tilde-team-id": "team_123",
    "x-tilde-session-id": "session_1",
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
      expect(await request.json()).toEqual({ messages: [] });
      expect(context.orgId).toBe("org-123");
      expect(context.teamId).toBe("team_123");
      expect(context.sessionId).toBe("session_1");
      expect(context.client.chatkit).toBeDefined();
      expect(context.session.id).toBe("session_1");
      return new Response("ok");
    });

    const endpoint = chatKitEndpoint({
      webhookSigningKey: key,
      handler,
    });

    const response = await endpoint(signedRequest({ messages: [] }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("loads session history through the typed session client", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(
        "https://api.example.test/api/v1/team/team_123/chatkit/sessions/session_1/messages?page_size=10&next_page_token=next",
      );
      return Response.json({
        items: [{ id: "msg_1" }],
        next_page_token: "older",
      });
    });
    const handler = vi.fn(async (_request: Request, context) => {
      await expect(
        context.session.history({ pageSize: 10, nextPageToken: "next" }),
      ).resolves.toEqual({
        items: [{ id: "msg_1" }],
        nextPageToken: "older",
      });
      return new Response("ok");
    });

    const endpoint = chatKitEndpoint({
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

  it("returns 400 before calling the handler when org id is missing", async () => {
    const handler = vi.fn(async () => new Response("ok"));
    const endpoint = chatKitEndpoint({
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
    const endpoint = chatKitEndpoint({
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
    const endpoint = chatKitEndpoint({
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

    const endpoint = chatKitEndpoint({
      webhookSigningKey: key,
      handler,
    });

    const response = await endpoint(request);
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });
});
