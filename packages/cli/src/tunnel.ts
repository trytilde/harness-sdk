import { type ChildProcess, spawn } from "node:child_process";
import http, { type Server } from "node:http";
import net from "node:net";
import {
  ApiError,
  type Config,
  configHeaders,
  createConfig,
  type JsonObject,
} from "@trytilde/harness-sdk";
import { ensureHarnessAuth, type HarnessAuthOptions } from "./auth";

export type LocalRuntimeTunnelConnector = {
  tunnel_domain: string;
  tunnel_origin: string;
  local_service_url?: string;
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

export type StartLocalRuntimeTunnelOptions = Config &
  HarnessAuthOptions & {
    cloudflaredPath?: string;
  };

export type RunLocalRuntimeTunnelCommandOptions =
  StartLocalRuntimeTunnelOptions & {
    command: string[];
    port?: number;
    portStart?: number;
  };

export type LocalRuntimeTunnelCommandProcess = LocalRuntimeTunnelProcess & {
  command: ChildProcess;
  localPort: number;
  proxyOrigin: string;
};

export async function startLocalRuntimeTunnel(
  options: StartLocalRuntimeTunnelOptions,
): Promise<LocalRuntimeTunnelProcess> {
  let configOptions: StartLocalRuntimeTunnelOptions = options;
  if (!options.apiKey && !options.bearerToken) {
    const tokens = await ensureHarnessAuth(options);
    configOptions = { ...options, bearerToken: tokens.accessToken };
  }
  const config = createConfig(configOptions);

  const connector = await fetchLocalRuntimeTunnelConnector(config);
  const child = spawn(
    options.cloudflaredPath ?? "cloudflared",
    ["tunnel", "run"],
    {
      env: {
        ...childEnvironment(),
        TUNNEL_TOKEN: connector.cloudflared_token,
      },
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

export async function runLocalRuntimeTunnelCommand(
  options: RunLocalRuntimeTunnelCommandOptions,
): Promise<LocalRuntimeTunnelCommandProcess> {
  if (options.command.length === 0) {
    throw new TypeError("command is required");
  }
  const [commandName, ...commandArgs] = options.command;
  if (!commandName) {
    throw new TypeError("command is required");
  }
  const tunnel = await startLocalRuntimeTunnel(options);
  const proxyUrl = new URL(
    tunnel.connector.local_service_url ?? "http://localhost:17654",
  );
  const proxyPort = Number(
    proxyUrl.port || (proxyUrl.protocol === "https:" ? 443 : 80),
  );
  const proxyHost = loopbackHost(proxyUrl.hostname);
  const localPort =
    options.port ?? (await findAvailablePort(options.portStart ?? 3000));
  const proxy =
    proxyPort === localPort
      ? undefined
      : await startHttpProxy({
          listenHost: proxyHost,
          listenPort: proxyPort,
          targetPort: localPort,
        });

  const command = spawn(
    commandName,
    commandArgs.map((arg) => arg.replaceAll("$TUNNEL_PORT", String(localPort))),
    {
      env: {
        ...childEnvironment(),
        PORT: String(localPort),
        TUNNEL_PORT: String(localPort),
        TILDE_TUNNEL_PORT: String(localPort),
        TILDE_LOCAL_RUNTIME_TUNNEL_ORIGIN: tunnel.connector.tunnel_origin,
        TILDE_LOCAL_RUNTIME_TUNNEL_DOMAIN: tunnel.connector.tunnel_domain,
      },
      stdio: "inherit",
    },
  );

  const stop = () => {
    if (!command.killed) {
      command.kill("SIGTERM");
    }
    proxy?.close();
    tunnel.stop();
  };

  command.once("close", stop);
  command.once("error", stop);

  return {
    ...tunnel,
    command,
    localPort,
    proxyOrigin: `${proxyUrl.protocol}//${proxyUrl.host}`,
    stop,
  };
}

function childEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env };
}

export async function findAvailablePort(start: number): Promise<number> {
  for (let port = start; port <= 65535; port += 1) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available TCP port found from ${start}`);
}

async function fetchLocalRuntimeTunnelConnector(
  config: ReturnType<typeof createConfig>,
): Promise<LocalRuntimeTunnelConnector> {
  const fetchImpl = config.fetch ?? fetch;
  const response = await fetchImpl(
    `${config.baseUrl}/api/v1/identity/local-runtime/tunnel-connector`,
    {
      method: "GET",
      headers: configHeaders(config),
    },
  );
  if (!response.ok) {
    const body = await response.text();
    let message = `Tilde API request failed with status ${response.status}`;
    if (body) {
      try {
        const parsed = JSON.parse(body) as JsonObject;
        const parsedMessage = parsed.message ?? parsed.error;
        if (typeof parsedMessage === "string" && parsedMessage.trim()) {
          message = parsedMessage;
        }
      } catch {
        message = body;
      }
    }
    throw new ApiError(message, response, body);
  }
  return (await response.json()) as LocalRuntimeTunnelConnector;
}

function loopbackHost(hostname: string): string {
  if (hostname === "localhost") {
    return "127.0.0.1";
  }
  return hostname;
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function startHttpProxy(options: {
  listenHost: string;
  listenPort: number;
  targetPort: number;
}): Promise<Server> {
  const server = http.createServer((incoming, outgoing) => {
    const proxyRequest = http.request(
      {
        hostname: "127.0.0.1",
        port: options.targetPort,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
      },
      (proxyResponse) => {
        outgoing.writeHead(
          proxyResponse.statusCode ?? 502,
          proxyResponse.headers,
        );
        proxyResponse.pipe(outgoing);
      },
    );
    proxyRequest.once("error", (error) => {
      outgoing.writeHead(502, { "Content-Type": "text/plain" });
      outgoing.end(`Local runtime proxy error: ${error.message}`);
    });
    incoming.pipe(proxyRequest);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.listenPort, options.listenHost, () => resolve());
  });

  return server;
}
