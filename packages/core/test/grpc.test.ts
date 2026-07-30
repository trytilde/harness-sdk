import { Metadata } from "nice-grpc";
import { describe, expect, it, vi } from "vitest";
import { createClient, createTildeGrpcReverseProxy } from "../src";

describe("createTildeGrpcReverseProxy", () => {
  it("derives routing and API-key metadata from the client", async () => {
    const proxy = createTildeGrpcReverseProxy({
      client: createClient({
        apiKey: "sk--test",
        baseUrl: "https://tunnel.example.test/api",
        orgId: "acme",
        orgSubdomain: false,
        teamId: "team-1",
      }),
      profileId: "rp-modal",
    });
    const next = vi.fn(async function* (
      _request: unknown,
      options: { metadata: Metadata },
    ) {
      yield options.metadata;
    });

    const result: Metadata[] = [];
    for await (const metadata of proxy.middleware(
      { request: {}, next } as never,
      { metadata: Metadata({ "x-request-id": "request-1" }) } as never,
    )) {
      result.push(metadata as Metadata);
    }

    expect(proxy.endpoint).toBe("https://tunnel.example.test");
    expect(next).toHaveBeenCalledOnce();
    expect(result[0]?.get("x-api-key")).toBe("sk--test");
    expect(result[0]?.get("x-tilde-org-id")).toBe("acme");
    expect(result[0]?.get("x-tilde-team-id")).toBe("team-1");
    expect(result[0]?.get("x-tilde-reverse-proxy-profile-id")).toBe("rp-modal");
    expect(result[0]?.get("x-request-id")).toBe("request-1");
  });

  it("supports bearer authentication", async () => {
    const proxy = createTildeGrpcReverseProxy({
      client: createClient({
        bearerToken: "token",
        baseUrl: "https://api.example.test",
        teamId: "team-1",
      }),
      profileId: "rp-modal",
    });
    const next = vi.fn(async function* (
      _request: unknown,
      options: { metadata: Metadata },
    ) {
      yield options.metadata;
    });

    const result: Metadata[] = [];
    for await (const metadata of proxy.middleware(
      { request: {}, next } as never,
      {} as never,
    )) {
      result.push(metadata as Metadata);
    }

    expect(result[0]?.get("authorization")).toBe("Bearer token");
    expect(result[0]?.get("x-api-key")).toBeUndefined();
  });

  it("requires a profile id", () => {
    const client = createClient({
      apiKey: "sk--test",
      teamId: "team-1",
    });

    expect(() =>
      createTildeGrpcReverseProxy({ client, profileId: " " }),
    ).toThrow("profileId is required");
  });
});
