import { spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { ApiError, type Config, type JsonObject } from "@tilde/harness-sdk";

const AUTH_VERSION = 1;
const TOKEN_EXPIRY_SKEW_SECONDS = 60;
const HARNESS_SDK_CLI_CLIENT_ID = "tilde-harness-sdk-cli";

export type HarnessAuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenType: string;
};

export type HarnessAuthOptions = {
  configDir?: string;
  openBrowser?: (url: string) => Promise<void> | void;
  useDeviceCode?: boolean;
};

export type EnsureHarnessAuthOptions = Config & HarnessAuthOptions;

type StoredHarnessAuth = {
  version: typeof AUTH_VERSION;
  baseUrl: string;
  accessToken: EncryptedValue;
  refreshToken: EncryptedValue;
  expiresAt: number;
  tokenType: string;
  selectedTeamId?: string;
  selectedOrgId?: string;
};

type EncryptedValue = {
  algorithm: "aes-256-gcm";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  expires_at?: number;
  token_type: string;
};

type OAuthCallbackResult =
  | { status: "success"; code: string; state?: string }
  | { status: "error"; error: string; errorDescription?: string };

type AuthConfig = {
  baseUrl: string;
  fetch?: typeof fetch;
};

export async function ensureHarnessAuth(
  options: EnsureHarnessAuthOptions,
): Promise<HarnessAuthTokens> {
  const config = createAuthConfig(options);
  const cached = readStoredTokens(config.baseUrl, options.configDir);
  if (cached) {
    const refreshed = await refreshOrUseCachedTokens(config, cached);
    if (refreshed) {
      writeStoredTokens(config.baseUrl, refreshed, options.configDir);
      return refreshed;
    }
  }

  const tokens = options.useDeviceCode
    ? await loginWithDeviceCode(config)
    : await loginWithBrowser(config, options);
  writeStoredTokens(config.baseUrl, tokens, options.configDir);
  return tokens;
}

function createAuthConfig(options: EnsureHarnessAuthOptions): AuthConfig {
  const baseUrlInput =
    options.baseUrl ?? env("TILDE_BASE_URL") ?? "https://api.trytilde.ai";
  let url: URL;
  try {
    url = new URL(baseUrlInput);
  } catch {
    throw new TypeError("baseUrl must be an absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("baseUrl must use http or https");
  }
  return {
    baseUrl: baseUrlInput.replace(/\/+$/, ""),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };
}

function env(name: string): string | undefined {
  if (typeof process === "undefined") {
    return undefined;
  }
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

type DeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

async function loginWithDeviceCode(
  config: AuthConfig,
): Promise<HarnessAuthTokens> {
  const device = await startDeviceCode(config);
  console.log(`Open this URL to sign in: ${device.verification_uri_complete}`);
  console.log(`Device code: ${device.user_code}`);
  const expiresAt = Date.now() + device.expires_in * 1000;
  let intervalMs = Math.max(device.interval, 1) * 1000;
  while (Date.now() < expiresAt) {
    await delay(intervalMs);
    try {
      return await exchangeDeviceCode(config, device.device_code);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("authorization_pending")) {
        continue;
      }
      if (message.includes("slow_down")) {
        intervalMs += 5000;
        continue;
      }
      throw error;
    }
  }
  throw new Error("Device code expired");
}

async function startDeviceCode(
  config: AuthConfig,
): Promise<DeviceCodeResponse> {
  const response = await (config.fetch ?? fetch)(
    `${config.baseUrl}/api/v1/identity/oauth/device/code`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: HARNESS_SDK_CLI_CLIENT_ID }),
    },
  );
  if (!response.ok) {
    throw await apiError(response, "OAuth device authorization failed");
  }
  return (await response.json()) as DeviceCodeResponse;
}

async function exchangeDeviceCode(
  config: AuthConfig,
  deviceCode: string,
): Promise<HarnessAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: HARNESS_SDK_CLI_CLIENT_ID,
    device_code: deviceCode,
  });
  const response = await (config.fetch ?? fetch)(
    `${config.baseUrl}/api/v1/identity/oauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );
  if (!response.ok) {
    throw await apiError(response, "OAuth device token exchange failed");
  }
  return normalizeTokenResponse((await response.json()) as TokenResponse);
}

async function refreshOrUseCachedTokens(
  config: AuthConfig,
  tokens: HarnessAuthTokens,
): Promise<HarnessAuthTokens | undefined> {
  if (!isExpired(tokens)) {
    if (await whoami(config, tokens.accessToken)) {
      return tokens;
    }
  }

  try {
    const refreshed = await refreshTokens(config, tokens.refreshToken);
    if (await whoami(config, refreshed.accessToken)) {
      return {
        ...refreshed,
        refreshToken: refreshed.refreshToken || tokens.refreshToken,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function loginWithBrowser(
  config: AuthConfig,
  options: HarnessAuthOptions,
): Promise<HarnessAuthTokens> {
  const callbackPort = await findAvailableAuthPort(14550);
  const redirectUri = `http://localhost:${callbackPort}/auth/callback`;
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = base64Url(randomBytes(24));

  const callback = waitForOAuthCallback(callbackPort);
  const authorizeUrl = new URL(
    `${config.baseUrl}/api/v1/identity/oauth/authorize`,
  );
  authorizeUrl.searchParams.set("client_id", HARNESS_SDK_CLI_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", "openid profile email offline_access");
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", state);

  console.log(`Opening Tilde sign-in: ${authorizeUrl.toString()}`);
  await (options.openBrowser ?? openBrowser)(authorizeUrl.toString());

  const result = await callback;
  if (result.status === "error") {
    throw new Error(
      result.errorDescription
        ? `${result.error}: ${result.errorDescription}`
        : result.error,
    );
  }
  if (!safeEqual(result.state ?? "", state)) {
    throw new Error("OAuth callback state did not match");
  }

  return exchangeOAuthCode(config, {
    code: result.code,
    codeVerifier: verifier,
    clientId: HARNESS_SDK_CLI_CLIENT_ID,
    redirectUri,
  });
}

async function exchangeOAuthCode(
  config: AuthConfig,
  params: {
    code: string;
    codeVerifier: string;
    clientId: string;
    redirectUri: string;
  },
): Promise<HarnessAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    code_verifier: params.codeVerifier,
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
  });
  const response = await (config.fetch ?? fetch)(
    `${config.baseUrl}/api/v1/identity/oauth/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );
  if (!response.ok) {
    throw await apiError(response, "OAuth token exchange failed");
  }
  return normalizeTokenResponse((await response.json()) as TokenResponse);
}

async function refreshTokens(
  config: AuthConfig,
  refreshToken: string,
): Promise<HarnessAuthTokens> {
  const response = await (config.fetch ?? fetch)(
    `${config.baseUrl}/api/v1/identity/auth/refresh`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    },
  );
  if (!response.ok) {
    throw await apiError(response, "OAuth token refresh failed");
  }
  return normalizeTokenResponse((await response.json()) as TokenResponse);
}

async function whoami(
  config: AuthConfig,
  accessToken: string,
): Promise<boolean> {
  const response = await (config.fetch ?? fetch)(
    `${config.baseUrl}/api/v1/identity/auth/whoami`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );
  return response.ok;
}

function normalizeTokenResponse(response: TokenResponse): HarnessAuthTokens {
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? "",
    expiresAt:
      response.expires_at ??
      Math.floor(Date.now() / 1000) + Number(response.expires_in || 0),
    tokenType: response.token_type || "Bearer",
  };
}

function isExpired(tokens: HarnessAuthTokens): boolean {
  return (
    tokens.expiresAt <=
    Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_SKEW_SECONDS
  );
}

function waitForOAuthCallback(port: number): Promise<OAuthCallbackResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => {
        server.close();
        reject(new Error("Timed out waiting for Tilde sign-in callback"));
      },
      5 * 60 * 1000,
    );
    const server = http.createServer((request, response) => {
      const requestUrl = new URL(
        request.url ?? "/",
        `http://localhost:${port}`,
      );
      if (requestUrl.pathname !== "/auth/callback") {
        response.writeHead(404, { "Content-Type": "text/plain" });
        response.end("Not found");
        return;
      }
      clearTimeout(timeout);
      const error = requestUrl.searchParams.get("error");
      let result: OAuthCallbackResult;
      if (error) {
        const errorDescription =
          requestUrl.searchParams.get("error_description");
        result = errorDescription
          ? { status: "error", error, errorDescription }
          : { status: "error", error };
      } else {
        const state = requestUrl.searchParams.get("state");
        result = state
          ? {
              status: "success",
              code: requestUrl.searchParams.get("code") ?? "",
              state,
            }
          : {
              status: "success",
              code: requestUrl.searchParams.get("code") ?? "",
            };
      }
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(
        "<!doctype html><title>Tilde</title>Signed in. You can close this tab.",
      );
      server.close(() => resolve(result));
    });
    server.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.listen(port, "localhost");
  });
}

async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["/c", "start", '""', url] : [url];

  await new Promise<void>((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", () => {
      console.log(`Open this URL to sign in: ${url}`);
      resolve();
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function findAvailableAuthPort(start: number): Promise<number> {
  for (let port = start; port <= 65535; port += 1) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available TCP port found from ${start}`);
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

function readStoredTokens(
  baseUrl: string,
  configDir?: string,
): HarnessAuthTokens | undefined {
  const stored = readStoredAuth(baseUrl, configDir);
  if (!stored) {
    return undefined;
  }
  try {
    return {
      accessToken: decryptValue(stored.accessToken),
      refreshToken: decryptValue(stored.refreshToken),
      expiresAt: stored.expiresAt,
      tokenType: stored.tokenType,
    };
  } catch {
    return undefined;
  }
}

export function writeStoredTokens(
  baseUrl: string,
  tokens: HarnessAuthTokens,
  configDir?: string,
): void {
  const dir = authHostDir(baseUrl, configDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stored: StoredHarnessAuth = {
    ...readStoredAuth(baseUrl, configDir),
    version: AUTH_VERSION,
    baseUrl: normalizeBaseUrl(baseUrl),
    accessToken: encryptValue(tokens.accessToken),
    refreshToken: encryptValue(tokens.refreshToken),
    expiresAt: tokens.expiresAt,
    tokenType: tokens.tokenType,
  };
  writeFileSync(
    authFilePath(baseUrl, configDir),
    `${JSON.stringify(stored, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
}

export function readSelectedTeamId(
  baseUrl: string,
  configDir?: string,
): string | undefined {
  return readStoredAuth(baseUrl, configDir)?.selectedTeamId;
}

export function readSelectedOrgId(
  baseUrl: string,
  configDir?: string,
): string | undefined {
  return readStoredAuth(baseUrl, configDir)?.selectedOrgId;
}

export function writeSelectedTeamId(
  baseUrl: string,
  teamId: string,
  orgId?: string,
  configDir?: string,
): void {
  const stored = readStoredAuth(baseUrl, configDir);
  if (!stored) {
    throw new Error("Sign in before selecting a Tilde team.");
  }
  const dir = authHostDir(baseUrl, configDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    authFilePath(baseUrl, configDir),
    `${JSON.stringify(
      {
        ...stored,
        selectedTeamId: teamId,
        ...(orgId ? { selectedOrgId: orgId } : {}),
      },
      null,
      2,
    )}\n`,
    {
      mode: 0o600,
    },
  );
}

export function deleteStoredAuth(baseUrl: string, configDir?: string): void {
  rmSync(authHostDir(baseUrl, configDir), { force: true, recursive: true });
}

function readStoredAuth(
  baseUrl: string,
  configDir?: string,
): StoredHarnessAuth | undefined {
  const filePath = authFilePath(baseUrl, configDir);
  if (!existsSync(filePath)) {
    return undefined;
  }
  try {
    const stored = JSON.parse(
      readFileSync(filePath, "utf8"),
    ) as StoredHarnessAuth;
    if (
      stored.version !== AUTH_VERSION ||
      stored.baseUrl !== normalizeBaseUrl(baseUrl)
    ) {
      return undefined;
    }
    return stored;
  } catch {
    return undefined;
  }
}

function authFilePath(baseUrl: string, configDir?: string): string {
  return join(authHostDir(baseUrl, configDir), "auth.json");
}

function authHostDir(baseUrl: string, configDir?: string): string {
  return join(
    authRootDir(configDir),
    "hosts",
    base64Url(Buffer.from(normalizeBaseUrl(baseUrl))),
  );
}

function authRootDir(configDir?: string): string {
  if (configDir) {
    return configDir;
  }
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir() || tmpdir(), ".config"),
    "tilde",
    "harness-sdk",
  );
}

function normalizeBaseUrl(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

function encryptValue(value: string): EncryptedValue {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = encryptionKey(salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return {
    algorithm: "aes-256-gcm",
    salt: salt.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

function decryptValue(value: EncryptedValue): string {
  const salt = Buffer.from(value.salt, "base64url");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(salt),
    Buffer.from(value.iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function encryptionKey(salt: Buffer): Buffer {
  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    username = "unknown";
  }
  return scryptSync(`${username}:${hostname()}:${homedir()}`, salt, 32);
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function apiError(
  response: Response,
  fallback: string,
): Promise<ApiError> {
  const body = await response.text();
  let message = fallback;
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
  return new ApiError(message, response, body);
}
