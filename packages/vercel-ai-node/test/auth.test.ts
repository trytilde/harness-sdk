import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ensureHarnessAuth, writeStoredTokens } from "../src/auth";

describe("harness auth cache", () => {
  it("uses a valid cached token after whoami succeeds", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "harness-sdk-auth-"));
    try {
      writeStoredTokens(
        "https://api.example.test",
        {
          accessToken: "cached-access",
          refreshToken: "cached-refresh",
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          tokenType: "Bearer",
        },
        configDir,
      );
      const fetchMock = viFetch(async (input, init) => {
        expect(String(input)).toBe(
          "https://api.example.test/api/v1/identity/auth/whoami",
        );
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer cached-access",
        );
        return Response.json({ id: "user_123" });
      });

      const tokens = await ensureHarnessAuth({
        baseUrl: "https://api.example.test",
        teamId: "team_123",
        configDir,
        fetch: fetchMock as typeof fetch,
      });

      expect(tokens.accessToken).toBe("cached-access");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(configDir, { force: true, recursive: true });
    }
  });

  it("refreshes expired cached tokens and stores encrypted token values", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "harness-sdk-auth-"));
    try {
      writeStoredTokens(
        "https://api.example.test",
        {
          accessToken: "old-access",
          refreshToken: "old-refresh",
          expiresAt: Math.floor(Date.now() / 1000) - 60,
          tokenType: "Bearer",
        },
        configDir,
      );
      const fetchMock = viFetch(async (input, init) => {
        if (String(input).endsWith("/api/v1/identity/auth/refresh")) {
          expect(await requestBody(init?.body)).toContain("old-refresh");
          return Response.json({
            access_token: "new-access",
            expires_in: 3600,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            token_type: "Bearer",
          });
        }
        expect(String(input)).toBe(
          "https://api.example.test/api/v1/identity/auth/whoami",
        );
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer new-access",
        );
        return Response.json({ id: "user_123" });
      });

      const tokens = await ensureHarnessAuth({
        baseUrl: "https://api.example.test",
        teamId: "team_123",
        configDir,
        fetch: fetchMock as typeof fetch,
      });

      expect(tokens.accessToken).toBe("new-access");
      expect(tokens.refreshToken).toBe("old-refresh");
      const authFile = readFileSync(
        join(
          configDir,
          "hosts",
          Buffer.from("https://api.example.test").toString("base64url"),
          "auth.json",
        ),
        "utf8",
      );
      expect(authFile).not.toContain("new-access");
      expect(authFile).not.toContain("old-refresh");
    } finally {
      rmSync(configDir, { force: true, recursive: true });
    }
  });

  it("supports device-code login when requested", async () => {
    vi.useFakeTimers();
    const configDir = mkdtempSync(join(tmpdir(), "harness-sdk-auth-"));
    const fetchMock = viFetch(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/v1/identity/oauth/device/code")) {
        return Response.json({
          device_code: "device-1",
          user_code: "ABCD-EFGH",
          verification_uri:
            "https://api.example.test/api/v1/identity/oauth/device/authorize",
          verification_uri_complete:
            "https://api.example.test/api/v1/identity/oauth/device/authorize?user_code=ABCD-EFGH",
          expires_in: 600,
          interval: 1,
        });
      }
      expect(url).toBe("https://api.example.test/api/v1/identity/oauth/token");
      expect(await requestBody(init?.body)).toContain(
        "urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code",
      );
      return Response.json({
        access_token: "device-access",
        refresh_token: "device-refresh",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        token_type: "Bearer",
      });
    });

    try {
      const promise = ensureHarnessAuth({
        baseUrl: "https://api.example.test",
        teamId: "team_123",
        configDir,
        fetch: fetchMock as typeof fetch,
        useDeviceCode: true,
      });
      await vi.advanceTimersByTimeAsync(1000);
      const tokens = await promise;

      expect(tokens.accessToken).toBe("device-access");
      expect(tokens.refreshToken).toBe("device-refresh");
    } finally {
      vi.useRealTimers();
      rmSync(configDir, { force: true, recursive: true });
    }
  });

  it("uses stable first-party browser PKCE login without dynamic client registration", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "harness-sdk-auth-"));
    const fetchMock = viFetch(async (input, init) => {
      const url = String(input);
      expect(url).not.toContain("/oauth/register");
      expect(url).toBe("https://api.example.test/api/v1/identity/oauth/token");
      const body = await requestBody(init?.body);
      expect(body).toContain("client_id=tilde-harness-sdk-cli");
      expect(body).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A");
      expect(body).toContain("%2Fauth%2Fcallback");
      return Response.json({
        access_token: "browser-access",
        refresh_token: "browser-refresh",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        token_type: "Bearer",
      });
    });

    try {
      const tokens = await ensureHarnessAuth({
        baseUrl: "https://api.example.test",
        teamId: "team_123",
        configDir,
        fetch: fetchMock as typeof fetch,
        openBrowser(url) {
          const parsed = new URL(url);
          expect(parsed.searchParams.get("client_id")).toBe(
            "tilde-harness-sdk-cli",
          );
          expect(parsed.searchParams.get("redirect_uri")).toMatch(
            /^http:\/\/localhost:\d+\/auth\/callback$/,
          );
          const redirectUri = parsed.searchParams.get("redirect_uri");
          if (!redirectUri) {
            throw new Error("redirect_uri missing");
          }
          setTimeout(() => {
            const callbackUrl = new URL(redirectUri);
            callbackUrl.searchParams.set("code", "browser-code");
            callbackUrl.searchParams.set(
              "state",
              parsed.searchParams.get("state") ?? "",
            );
            fetch(callbackUrl).catch(() => undefined);
          }, 0);
        },
      });

      expect(tokens.accessToken).toBe("browser-access");
      expect(tokens.refreshToken).toBe("browser-refresh");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(configDir, { force: true, recursive: true });
    }
  });
});

function viFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  return vi.fn(handler);
}

async function requestBody(body: BodyInit | null | undefined): Promise<string> {
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  if (typeof body === "string") {
    return body;
  }
  return "";
}
