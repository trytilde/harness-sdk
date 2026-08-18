import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ApiError } from "@trytilde/harness-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLocalRuntimeTunnelCommand, startLocalRuntimeTunnel } from "../src";

const { spawnMock, execFileSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => ({
    killed: false,
    kill: vi.fn(),
    once: vi.fn(),
  })),
  execFileSyncMock: vi.fn(() => "cloudflared\n"),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  execFileSync: execFileSyncMock,
}));

let previousXdgConfigHome: string | undefined;

beforeEach(() => {
  previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "tunnel-test-"));
});

afterEach(() => {
  if (previousXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
  }
});

function connectorResponse() {
  return Response.json({
    tunnel_domain: "user-abc.tunnel.trytilde-dev.com",
    tunnel_origin: "https://user-abc.tunnel.trytilde-dev.com",
    local_service_url: "http://localhost:17654",
    cloudflared_token: "cloudflare-token",
  });
}

function tunnelPidFile(): string {
  return join(
    process.env.XDG_CONFIG_HOME as string,
    "tilde",
    "harness-sdk",
    "tunnels",
    "user-abc.tunnel.trytilde-dev.com.pid",
  );
}

describe("startLocalRuntimeTunnel", () => {
  it("starts cloudflared with a connector token", async () => {
    spawnMock.mockClear();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://api.example.test/api/v1/identity/local-runtime/tunnel-connector",
        );
        expect(init?.method).toBe("GET");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer tilde-access-token",
        );
        return Response.json({
          tunnel_domain: "user-abc.tunnel.trytilde-dev.com",
          tunnel_origin: "https://user-abc.tunnel.trytilde-dev.com",
          local_service_url: "http://localhost:17654",
          cloudflared_token: "cloudflare-token",
        });
      },
    );

    const tunnel = await startLocalRuntimeTunnel({
      baseUrl: "https://api.example.test",
      teamId: "team_123",
      bearerToken: "tilde-access-token",
      cloudflaredPath: "cloudflared-test",
      fetch: fetchMock as typeof fetch,
    });

    expect(tunnel.connector.tunnel_origin).toBe(
      "https://user-abc.tunnel.trytilde-dev.com",
    );
    expect(tunnel.connector.local_service_url).toBe("http://localhost:17654");
    expect(spawnMock).toHaveBeenCalledWith(
      "cloudflared-test",
      ["tunnel", "run"],
      expect.objectContaining({
        env: expect.objectContaining({
          TUNNEL_TOKEN: "cloudflare-token",
        }),
        stdio: "inherit",
      }),
    );
  });

  it("throws ApiError when connector lookup fails", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ message: "bad key" }, { status: 401 }),
    );

    await expect(
      startLocalRuntimeTunnel({
        baseUrl: "https://api.example.test",
        teamId: "team_123",
        bearerToken: "bad-token",
        fetch: fetchMock as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("runs a command on the selected tunnel port", async () => {
    spawnMock.mockClear();
    const previousWebhookSigningKey =
      process.env.TILDE_CHATKIT_WEBHOOK_SIGNING_KEY;
    process.env.TILDE_CHATKIT_WEBHOOK_SIGNING_KEY = "webhook-secret";
    const fetchMock = vi.fn(async () =>
      Response.json({
        tunnel_domain: "user-abc.tunnel.trytilde-dev.com",
        tunnel_origin: "https://user-abc.tunnel.trytilde-dev.com",
        local_service_url: "http://localhost:3100",
        cloudflared_token: "cloudflare-token",
      }),
    );

    try {
      const process = await runLocalRuntimeTunnelCommand({
        baseUrl: "https://api.example.test",
        teamId: "team_123",
        bearerToken: "tilde-access-token",
        cloudflaredPath: "cloudflared-test",
        fetch: fetchMock as typeof fetch,
        port: 3100,
        command: ["next", "dev", "-p", "$TUNNEL_PORT"],
      });

      expect(process.localPort).toBe(3100);
      expect(spawnMock).toHaveBeenNthCalledWith(
        2,
        "next",
        ["dev", "-p", "3100"],
        expect.objectContaining({
          env: expect.objectContaining({
            PORT: "3100",
            TUNNEL_PORT: "3100",
            TILDE_TUNNEL_PORT: "3100",
            TILDE_LOCAL_RUNTIME_TUNNEL_ORIGIN:
              "https://user-abc.tunnel.trytilde-dev.com",
            TILDE_LOCAL_RUNTIME_TUNNEL_DOMAIN:
              "user-abc.tunnel.trytilde-dev.com",
          }),
          stdio: "inherit",
        }),
      );
      const childSpawnCall = spawnMock.mock.calls[1] as unknown[] | undefined;
      const childSpawnOptions = childSpawnCall?.[2] as
        | { env?: NodeJS.ProcessEnv }
        | undefined;
      const childEnv = childSpawnOptions?.env as NodeJS.ProcessEnv | undefined;
      expect(childEnv?.TILDE_CHATKIT_WEBHOOK_SIGNING_KEY).toBe(
        "webhook-secret",
      );
    } finally {
      if (previousWebhookSigningKey === undefined) {
        delete process.env.TILDE_CHATKIT_WEBHOOK_SIGNING_KEY;
      } else {
        process.env.TILDE_CHATKIT_WEBHOOK_SIGNING_KEY =
          previousWebhookSigningKey;
      }
    }
  });
});

describe("tunnel connector lifecycle", () => {
  it("records the connector pid and reaps a leaked connector on restart", async () => {
    spawnMock.mockClear();
    execFileSyncMock.mockClear();
    spawnMock.mockReturnValueOnce({
      killed: false,
      kill: vi.fn(),
      once: vi.fn(),
      pid: 4242,
    } as never);
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true as never);

    mkdirSync(dirname(tunnelPidFile()), { recursive: true });
    writeFileSync(tunnelPidFile(), "9999");

    try {
      await startLocalRuntimeTunnel({
        baseUrl: "https://api.example.test",
        teamId: "team_123",
        bearerToken: "tilde-access-token",
        fetch: vi.fn(async () => connectorResponse()) as typeof fetch,
      });

      expect(killSpy).toHaveBeenCalledWith(9999, "SIGTERM");
      expect(execFileSyncMock).toHaveBeenCalledWith(
        "ps",
        ["-p", "9999", "-o", "comm="],
        expect.objectContaining({ encoding: "utf8" }),
      );
      expect(readFileSync(tunnelPidFile(), "utf8")).toBe("4242");
    } finally {
      killSpy.mockRestore();
    }
  });

  it("does not signal a reused pid that is no longer cloudflared", async () => {
    spawnMock.mockClear();
    execFileSyncMock.mockClear();
    execFileSyncMock.mockReturnValueOnce("node\n");
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true as never);
    mkdirSync(dirname(tunnelPidFile()), { recursive: true });
    writeFileSync(tunnelPidFile(), "9999");

    try {
      await startLocalRuntimeTunnel({
        baseUrl: "https://api.example.test",
        teamId: "team_123",
        bearerToken: "tilde-access-token",
        fetch: vi.fn(async () => connectorResponse()) as typeof fetch,
      });

      expect(killSpy).not.toHaveBeenCalledWith(9999, "SIGTERM");
    } finally {
      killSpy.mockRestore();
    }
  });

  it("stops the connector when the wrapper process is signalled", async () => {
    spawnMock.mockClear();
    const kill = vi.fn();
    spawnMock.mockReturnValueOnce({
      killed: false,
      kill,
      once: vi.fn(),
      pid: 4243,
    } as never);

    const before = process.listeners("SIGTERM").length;
    await startLocalRuntimeTunnel({
      baseUrl: "https://api.example.test",
      teamId: "team_123",
      bearerToken: "tilde-access-token",
      fetch: vi.fn(async () => connectorResponse()) as typeof fetch,
    });
    const handlers = process.listeners("SIGTERM");
    expect(handlers.length).toBe(before + 1);

    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true as never);
    try {
      (handlers[handlers.length - 1] as () => void)();
      expect(kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      killSpy.mockRestore();
    }
  });
});
