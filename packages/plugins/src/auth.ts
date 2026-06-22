import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

export type DesktopAuthOptions = {
  baseUrl: string;
  homeDir: string;
  interactive: boolean;
  fetch?: typeof fetch;
};

type TokenSet = {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
};

type TokenStore = {
  tokens?: Record<string, TokenSet>;
};

export async function ensureDesktopAuth(options: DesktopAuthOptions): Promise<string> {
  const stored = await readToken(options);
  if (stored?.access_token && await tokenWorks(options, stored.access_token)) {
    return stored.access_token;
  }
  if (stored?.refresh_token) {
    const refreshed = await refreshAccessToken(options, stored.refresh_token);
    if (refreshed) {
      await writeToken(options, refreshed);
      return refreshed.access_token;
    }
  }
  if (!options.interactive) {
    throw new Error("Desktop auth requires --interactive, TILDE_API_KEY, or an existing stored Tilde token in non-interactive mode");
  }
  const token = await runBrowserPkceAuth(options);
  await writeToken(options, token);
  return token.access_token;
}

async function runBrowserPkceAuth(options: DesktopAuthOptions): Promise<TokenSet> {
  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());
  const state = base64Url(randomBytes(24));
  const callback = await createCallbackServer(state);
  const redirectUri = `http://127.0.0.1:${callback.port}/callback`;
  try {
    const client = await registerOAuthClient(options, redirectUri);
    const authorizeUrl = new URL("/api/v1/identity/oauth/authorize", options.baseUrl);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", client.client_id);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", "mcp:tools");
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    process.stderr.write(`Opening browser for Tilde auth: ${authorizeUrl.toString()}\n`);
    openBrowser(authorizeUrl.toString());
    const code = await callback.code;
    const token = await exchangeCode(options, {
      code,
      codeVerifier,
      clientId: client.client_id,
      redirectUri,
    });
    return token;
  } finally {
    await callback.close();
  }
}

async function registerOAuthClient(options: DesktopAuthOptions, redirectUri: string): Promise<{ client_id: string }> {
  const response = await fetchWithNetworkError(options, "/api/v1/identity/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Tilde Harness Plugins",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "mcp:tools",
      token_endpoint_auth_method: "none",
      resource: new URL("/mcp", options.baseUrl).toString(),
    }),
  });
  if (!response.ok) {
    throw new Error(`OAuth client registration failed ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<{ client_id: string }>;
}

async function exchangeCode(
  options: DesktopAuthOptions,
  input: { code: string; codeVerifier: string; clientId: string; redirectUri: string },
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.codeVerifier,
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
  });
  const response = await fetchWithNetworkError(options, "/api/v1/identity/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error(`OAuth token exchange failed ${response.status}: ${await response.text()}`);
  }
  const token = await response.json() as { access_token: string; refresh_token: string; expires_in?: number };
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    ...(token.expires_in ? { expires_at: Date.now() + token.expires_in * 1000 } : {}),
  };
}

async function refreshAccessToken(options: DesktopAuthOptions, refreshToken: string): Promise<TokenSet | null> {
  const response = await fetchWithNetworkError(options, "/api/v1/identity/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!response.ok) return null;
  const body = await response.json() as { access_token: string; refresh_token?: string | null; expires_in?: number };
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? refreshToken,
    ...(body.expires_in ? { expires_at: Date.now() + body.expires_in * 1000 } : {}),
  };
}

async function tokenWorks(options: DesktopAuthOptions, accessToken: string): Promise<boolean> {
  const response = await fetchWithNetworkError(options, "/api/v1/identity/auth/whoami", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return response.ok;
}

async function createCallbackServer(expectedState: string): Promise<{
  port: number;
  code: Promise<string>;
  close: () => Promise<void>;
}> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const codeParam = url.searchParams.get("code");
    const stateParam = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    if (error) {
      rejectCode(new Error(`OAuth authorization failed: ${error}`));
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("Tilde authorization failed. You can close this tab.");
      return;
    }
    if (!codeParam || stateParam !== expectedState) {
      rejectCode(new Error("OAuth callback did not include a valid code/state"));
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("Invalid Tilde authorization callback. You can close this tab.");
      return;
    }
    resolveCode(codeParam);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("Tilde authorization complete. You can close this tab.");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind local OAuth callback server");
  }
  return {
    port: address.port,
    code,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function readToken(options: DesktopAuthOptions): Promise<TokenSet | undefined> {
  try {
    const store = JSON.parse(await readFile(tokenStorePath(options.homeDir), "utf8")) as TokenStore;
    return store.tokens?.[options.baseUrl];
  } catch {
    return undefined;
  }
}

async function writeToken(options: DesktopAuthOptions, token: TokenSet): Promise<void> {
  const path = tokenStorePath(options.homeDir);
  let store: TokenStore = {};
  try {
    store = JSON.parse(await readFile(path, "utf8")) as TokenStore;
  } catch {}
  store.tokens ??= {};
  store.tokens[options.baseUrl] = token;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

function tokenStorePath(homeDir: string): string {
  return join(homeDir, ".tilde", "harness-plugins", "auth.json");
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" :
      process.platform === "win32" ? "cmd" :
        "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {
    process.stderr.write(`Open this URL to authenticate: ${url}\n`);
  });
  child.unref();
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fetchImpl(options: DesktopAuthOptions): typeof fetch {
  return options.fetch ?? fetch;
}

async function fetchWithNetworkError(
  options: DesktopAuthOptions,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(path, options.baseUrl);
  try {
    return await fetchImpl(options)(url, init);
  } catch (error) {
    throw new Error(`Tilde auth request failed before HTTP response for ${url.toString()}: ${formatFetchError(error)}`);
  }
}

function formatFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause instanceof Error) {
    const code = "code" in cause ? ` ${(cause as { code?: string }).code}` : "";
    const address = "address" in cause ? ` ${(cause as { address?: string }).address}` : "";
    const port = "port" in cause ? `:${(cause as { port?: number }).port}` : "";
    return `${error.message}; caused by ${cause.message}${code}${address}${port}`;
  }
  return error.message;
}
