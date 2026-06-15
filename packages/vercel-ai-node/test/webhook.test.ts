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
) {
  const raw = new TextEncoder().encode(JSON.stringify(body));
  return new Request("https://example.test/webhook", {
    method: "POST",
    headers: {
      [TILDE_WEBHOOK_ID_HEADER]: "webhook-123",
      [TILDE_WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
      [TILDE_WEBHOOK_SIGNATURE_HEADER]: signBody(key, timestamp, raw),
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

  it("returns 401 before calling the handler on invalid signatures", async () => {
    const handler = vi.fn(async () => new Response("ok"));
    const request = signedRequest({ messages: [] });
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
