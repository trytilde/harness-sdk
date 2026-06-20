import { configFetch, type NormalizedConfig } from "./config";
import { errorFromResponse } from "./errors";

export type LocalRuntimeTunnelConnector = {
  tunnel_domain: string;
  tunnel_origin: string;
  cloudflared_token: string;
};

export type LocalRuntimeTunnelProcess = {
  connector: LocalRuntimeTunnelConnector;
  closed: Promise<LocalRuntimeTunnelExit>;
  stop: () => void;
};

export type LocalRuntimeTunnelExit = {
  code: number | null;
  signal: string | null;
};

export async function startLocalRuntimeTunnel(
  config: NormalizedConfig,
): Promise<LocalRuntimeTunnelProcess> {
  if (!config.apiKey) {
    throw new TypeError("apiKey is required to start a local runtime tunnel");
  }
  assertNodeRuntime();

  const connector = await fetchLocalRuntimeTunnelConnector(config);
  const { spawn } = await import("node:child_process");
  const child = spawn(
    config.cloudflaredPath ?? "cloudflared",
    ["tunnel", "run", "--token", connector.cloudflared_token],
    {
      stdio: "inherit",
    },
  );

  child.once("error", (error) => {
    console.error("Failed to start cloudflared tunnel", error);
  });
  const closed = new Promise<LocalRuntimeTunnelExit>((resolve) => {
    child.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });

  return {
    connector,
    closed,
    stop: () => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
    },
  };
}

async function fetchLocalRuntimeTunnelConnector(
  config: NormalizedConfig,
): Promise<LocalRuntimeTunnelConnector> {
  const response = await configFetch(config)(
    `${config.baseUrl}/api/v1/identity/local-runtime/tunnel-connector`,
    {
      method: "GET",
      headers: {
        "x-api-key": config.apiKey ?? "",
      },
    },
  );
  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  return (await response.json()) as LocalRuntimeTunnelConnector;
}

function assertNodeRuntime() {
  if (typeof process === "undefined" || !process.versions?.node) {
    throw new TypeError("tunnel requires a Node.js runtime");
  }
}
