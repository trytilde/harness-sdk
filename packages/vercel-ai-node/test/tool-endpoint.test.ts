import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import {
  signBody,
  TILDE_WEBHOOK_ID_HEADER,
  TILDE_WEBHOOK_SIGNATURE_HEADER,
  TILDE_WEBHOOK_TIMESTAMP_HEADER,
  toolEndpoint,
} from "../src";

const key = "whsec--tool-endpoint-test";

function signedRequest(
  url: string,
  method: "GET" | "POST",
  body?: unknown,
): Request {
  const rawBody =
    body === undefined
      ? new Uint8Array()
      : new TextEncoder().encode(JSON.stringify(body));
  const timestamp = Math.floor(Date.now() / 1000);
  return new Request(url, {
    method,
    headers: {
      [TILDE_WEBHOOK_ID_HEADER]: "webhook-tool-1",
      [TILDE_WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
      [TILDE_WEBHOOK_SIGNATURE_HEADER]: signBody(key, timestamp, rawBody),
      "Content-Type": "application/json",
    },
    ...(method === "POST" ? { body: rawBody, duplex: "half" } : {}),
  } as RequestInit);
}

function createEndpoint(
  fn = vi.fn(async ({ name }: { name: string }, request: Request) => ({
    greeting: `${request.headers.get("x-request-source") ?? "Hello"}, ${name}!`,
  })),
) {
  return toolEndpoint({
    webhookSigningKey: key,
    provider: {
      name: "Example tools",
      description: "Example remote tools",
      version: "1.0.0",
    },
    tools: [
      {
        id: "greet",
        name: "Greet",
        description: "Greet a person by name.",
        inputSchema: z.object({ name: z.string() }),
        outputSchema: z.object({ greeting: z.string() }),
        fn,
      },
    ],
  });
}

describe("toolEndpoint", () => {
  it("infers the invocation URL and publishes Zod schemas", async () => {
    const endpoint = createEndpoint();
    const response = await endpoint.GET(
      signedRequest(
        "https://agents.example.test/api/tools?preview=true",
        "GET",
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      provider: {
        name: "Example tools",
        description: "Example remote tools",
        version: "1.0.0",
      },
      invoke_url: "https://agents.example.test/api/tools",
      tools: [
        {
          type_id: "greet",
          name: "Greet",
          description: "Greet a person by name.",
          input_schema: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
          output_schema: {
            type: "object",
            properties: { greeting: { type: "string" } },
            required: ["greeting"],
          },
        },
      ],
    });
  });

  it("uses public URL overrides behind a proxy", async () => {
    const endpoint = toolEndpoint({
      webhookSigningKey: key,
      baseUrl: "https://public.example.test/internal-base",
      endpointPath: "/v1/tools",
      provider: { name: "Example tools" },
      tools: [
        {
          id: "ping",
          name: "Ping",
          description: "Return pong.",
          inputSchema: z.object({}),
          outputSchema: z.object({ pong: z.boolean() }),
          async fn() {
            return { pong: true };
          },
        },
      ],
    });

    const response = await endpoint.GET(
      signedRequest("http://internal:3000/ignored", "GET"),
    );
    expect(await response.json()).toMatchObject({
      invoke_url: "https://public.example.test/v1/tools",
    });
  });

  it("verifies, parses, invokes, and validates a tool call", async () => {
    const fn = vi.fn(async (input: { name: string }, request: Request) => {
      expect(await request.json()).toMatchObject({
        tool_source_type_id: "greet",
      });
      return {
        greeting: `${request.headers.get("x-request-source")}, ${input.name}!`,
      };
    });
    const endpoint = createEndpoint(fn);
    const request = signedRequest(
      "https://agents.example.test/api/tools",
      "POST",
      {
        tool_source_type_id: "greet",
        params: { name: "Ada", ignored: true },
      },
    );
    request.headers.set("x-request-source", "Welcome");

    const response = await endpoint.POST(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      greeting: "Welcome, Ada!",
      type: "success",
    });
    expect(fn).toHaveBeenCalledOnce();
    expect(fn.mock.calls[0]?.[0]).toEqual({ name: "Ada" });
  });

  it("infers fn input and output from sibling Zod schemas", () => {
    toolEndpoint({
      webhookSigningKey: key,
      provider: { name: "Typed tools" },
      tools: [
        {
          id: "typed",
          name: "Typed",
          description: "Check inferred types.",
          inputSchema: z.object({ count: z.number() }),
          outputSchema: z.object({ doubled: z.number() }),
          async fn(input, request) {
            expectTypeOf(input).toEqualTypeOf<{ count: number }>();
            expectTypeOf(request).toEqualTypeOf<Request>();
            return { doubled: input.count * 2 };
          },
        },
      ],
    });
  });

  it("rejects unsigned requests before invoking a tool", async () => {
    const fn = vi.fn(async () => ({ greeting: "Hello" }));
    const endpoint = createEndpoint(fn);
    const response = await endpoint.POST(
      new Request("https://agents.example.test/api/tools", {
        method: "POST",
        body: "{}",
      }),
    );

    expect(response.status).toBe(401);
    expect(fn).not.toHaveBeenCalled();
  });

  it("returns invocation errors for unknown tools and invalid schemas", async () => {
    const endpoint = createEndpoint();
    const unknown = await endpoint.POST(
      signedRequest("https://agents.example.test/api/tools", "POST", {
        tool_source_type_id: "missing",
        params: {},
      }),
    );
    expect(await unknown.json()).toEqual({
      type: "error",
      message: "Unknown tool: missing",
    });

    const invalidInput = await endpoint.POST(
      signedRequest("https://agents.example.test/api/tools", "POST", {
        tool_source_type_id: "greet",
        params: { name: 42 },
      }),
    );
    expect(await invalidInput.json()).toMatchObject({ type: "error" });
  });

  it("validates configuration eagerly", () => {
    expect(() =>
      toolEndpoint({
        webhookSigningKey: key,
        baseUrl: "not-a-url",
        provider: { name: "Example" },
        tools: [
          {
            id: "ping",
            name: "Ping",
            description: "Return pong.",
            inputSchema: z.object({}),
            outputSchema: z.object({ pong: z.boolean() }),
            async fn() {
              return { pong: true };
            },
          },
        ],
      }),
    ).toThrow("baseUrl must be an absolute URL");

    expect(() =>
      toolEndpoint({
        webhookSigningKey: key,
        endpointPath: "api/tools",
        provider: { name: "Example" },
        tools: [
          {
            id: "ping",
            name: "Ping",
            description: "Return pong.",
            inputSchema: z.object({}),
            outputSchema: z.object({ pong: z.boolean() }),
            async fn() {
              return { pong: true };
            },
          },
        ],
      }),
    ).toThrow("endpointPath must start with /");
  });
});
