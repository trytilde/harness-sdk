import { type ClientMiddleware, Metadata } from "nice-grpc";
import type { Client } from "./client";

export type CreateTildeGrpcReverseProxyOptions = {
  client: Client;
  profileId: string;
};

export type TildeGrpcReverseProxy = {
  endpoint: string;
  middleware: ClientMiddleware;
};

export function createTildeGrpcReverseProxy(
  options: CreateTildeGrpcReverseProxyOptions,
): TildeGrpcReverseProxy {
  const { client, profileId } = options;
  if (!profileId.trim()) {
    throw new TypeError("profileId is required");
  }

  return {
    endpoint: new URL(client.config.baseUrl).origin,
    middleware: async function* tildeGrpcReverseProxy(call, callOptions) {
      const metadata = callOptions.metadata ?? Metadata();
      applyAuthentication(metadata, client);
      if (client.config.orgId) {
        metadata.set("x-tilde-org-id", client.config.orgId);
      }
      metadata.set("x-tilde-team-id", client.config.teamId);
      metadata.set("x-tilde-reverse-proxy-profile-id", profileId);
      return yield* call.next(call.request, {
        ...callOptions,
        metadata,
      });
    },
  };
}

function applyAuthentication(metadata: Metadata, client: Client): void {
  const configuredHeaders = new Headers(client.config.headers);
  const explicitApiKey = configuredHeaders.get("x-api-key");
  const explicitAuthorization = configuredHeaders.get("authorization");

  if (explicitApiKey) {
    metadata.set("x-api-key", explicitApiKey);
  } else if (client.config.apiKey) {
    metadata.set("x-api-key", client.config.apiKey);
  }

  if (explicitAuthorization) {
    metadata.set("authorization", explicitAuthorization);
  } else if (client.config.bearerToken) {
    metadata.set("authorization", `Bearer ${client.config.bearerToken}`);
  }
}
