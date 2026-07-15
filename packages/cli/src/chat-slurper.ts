import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type ChatSlurperProvider = "codex" | "claude-code";
export type ChatSlurperAction =
  | "configure"
  | "backfill"
  | "status"
  | "disable"
  | "capture-hook"
  | "flush-hooks";

export type ChatSlurperCommandOptions = {
  action: ChatSlurperAction;
  baseUrl: string;
  accessToken: string;
  orgId?: string;
  teamId: string;
  provider?: ChatSlurperProvider;
  memoryBankId?: string;
  quiet?: boolean;
  select<T>(input: {
    title: string;
    items: Array<{ label: string; value: T }>;
  }): Promise<T>;
};

type ChatSlurperSource = {
  id: string;
  application: ChatSlurperProvider;
  display_name: string;
  status: "enabled" | "disabled";
};

type ChatSlurperSyncRun = {
  status: "running" | "completed" | "failed";
  sessions_processed: number;
  entries_processed: number;
  error?: string | null;
  updated_at: string;
};

type MemoryBank = {
  id: string;
  name: string;
  description?: string | null;
  status?: string;
};

type ProviderConfiguration = {
  sourceId: string;
  memoryBankId: string;
  configuredAt: string;
  hookFile: string;
};

type QueuedHook = {
  version: 1;
  provider: ChatSlurperProvider;
  transcriptPath: string;
  queuedAt: string;
};

type ChatSlurperConfiguration = {
  version: 1;
  baseUrl: string;
  orgId?: string;
  teamId: string;
  providers: Partial<Record<ChatSlurperProvider, ProviderConfiguration>>;
};

export type NormalizedHistoryEntry = {
  provider_entry_id: string;
  sequence: number;
  entry_type: string;
  actor: Record<string, unknown>;
  content: unknown;
  occurred_at: string;
  metadata: Record<string, unknown>;
};

export type NormalizedHistorySession = {
  provider_session_id: string;
  title?: string;
  started_at: string;
  ended_at?: string;
  last_activity_at: string;
  repository?: string;
  git_remote?: string;
  branch?: string;
  head_sha?: string;
  working_directory?: string;
  agent_name: string;
  model?: string;
  metadata: Record<string, unknown>;
  entries: NormalizedHistoryEntry[];
};

type ProviderAdapter = {
  id: ChatSlurperProvider;
  label: string;
  historyRoot(home: string): string;
  hookFile(home: string): string;
  hookEvents: string[];
};

const adapters: Record<ChatSlurperProvider, ProviderAdapter> = {
  codex: {
    id: "codex",
    label: "Codex / Codex Desktop",
    historyRoot: (home) => join(home, ".codex", "sessions"),
    hookFile: (home) => join(home, ".codex", "hooks.json"),
    hookEvents: ["Stop"],
  },
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    historyRoot: (home) => join(home, ".claude", "projects"),
    hookFile: (home) => join(home, ".claude", "settings.json"),
    hookEvents: ["Stop", "SessionEnd"],
  },
};

const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024;
const MAX_TRANSCRIPT_FILES = 10_000;
const MAX_ENTRY_CONTENT_BYTES = 64 * 1024;
const MAX_UPLOAD_BATCH_BYTES = 1_250_000;
const API_TIMEOUT_MS = 30_000;

export async function runChatSlurperCommand(
  options: ChatSlurperCommandOptions,
): Promise<void> {
  switch (options.action) {
    case "configure":
      await configure(options);
      return;
    case "backfill":
      await backfill(options, "backfill");
      return;
    case "status":
      await status(options);
      return;
    case "disable":
      await disable(options);
      return;
    case "capture-hook":
      await enqueueCaptureHook(options.provider);
      return;
    case "flush-hooks":
      await flushHooks(options);
  }
}

async function configure(options: ChatSlurperCommandOptions): Promise<void> {
  const home = homedir();
  const detected = Object.values(adapters).filter((adapter) =>
    existsSync(adapter.historyRoot(home)),
  );
  const choices = detected.length > 0 ? detected : Object.values(adapters);
  const provider =
    options.provider ??
    (await options.select({
      title: "Select an AI application",
      items: choices.map((adapter) => ({
        label: adapter.label,
        value: adapter.id,
      })),
    }));
  const adapter = adapters[provider];
  validateHookFile(adapter, home);
  const banks = await api<{ items?: MemoryBank[] }>(options, {
    path: `/api/v1/team/${encodeURIComponent(options.teamId)}/memory/banks?page_size=100`,
  });
  const bankItems = banks.items ?? [];
  if (bankItems.length === 0) {
    throw new Error(
      "This team has no memory banks. Create a memory bank first.",
    );
  }
  const memoryBankId =
    options.memoryBankId ??
    (await options.select({
      title: "Select a memory bank",
      items: bankItems.map((bank) => ({
        label: `${bank.name}${bank.status ? ` (${bank.status})` : ""}`,
        value: bank.id,
      })),
    }));
  if (!bankItems.some((bank) => bank.id === memoryBankId)) {
    throw new Error(
      `Memory bank ${memoryBankId} was not returned for this team.`,
    );
  }

  const source = await api<ChatSlurperSource>(options, {
    path: `/api/v1/team/${encodeURIComponent(options.teamId)}/chat-slurper/sources`,
    method: "POST",
    body: {
      device_id: stableDeviceId(),
      application: provider,
      display_name: `${adapter.label} on ${hostname()}`,
      integration_version: "harness-sdk/0.1",
      metadata: { hostname: hostname(), platform: process.platform },
    },
  });
  await api(options, {
    path: `/api/v1/team/${encodeURIComponent(options.teamId)}/memory/source-bindings`,
    method: "PUT",
    body: {
      source_kind: "chat_slurper",
      source_id: source.id,
      memory_bank_ids: [memoryBankId],
    },
  });
  installProviderHooks(provider, home);
  const config = readConfiguration() ?? {
    version: 1,
    baseUrl: options.baseUrl,
    ...(options.orgId ? { orgId: options.orgId } : {}),
    teamId: options.teamId,
    providers: {},
  };
  config.baseUrl = options.baseUrl;
  config.teamId = options.teamId;
  if (options.orgId) config.orgId = options.orgId;
  config.providers[provider] = {
    sourceId: source.id,
    memoryBankId,
    configuredAt: new Date().toISOString(),
    hookFile: adapter.hookFile(home),
  };
  writeConfiguration(config);
  console.log(`Configured ${adapter.label} for memory bank ${memoryBankId}.`);
  console.log(`Installed Tilde capture hooks in ${adapter.hookFile(home)}.`);
  if (provider === "codex") {
    console.log(
      "Open `/hooks` in Codex and trust the new Tilde hook before it can run.",
    );
  }
}

async function backfill(
  options: ChatSlurperCommandOptions,
  kind: "live" | "backfill",
  transcriptPath?: string,
): Promise<void> {
  const config = requiredConfiguration(options);
  const providers = options.provider
    ? [options.provider]
    : (Object.keys(config.providers) as ChatSlurperProvider[]);
  if (providers.length === 0) {
    throw new Error(
      "No AI applications configured. Run `tilde chat-slurper configure`.",
    );
  }
  for (const provider of providers) {
    const source = config.providers[provider];
    if (!source) {
      throw new Error(`${adapters[provider].label} is not configured.`);
    }
    const run = await api<{ id: string }>(options, {
      path: syncRunsPath(options.teamId, source.sourceId),
      method: "POST",
      body: { client_request_id: randomUUID(), kind, cursor: null },
    });
    try {
      const sessions = transcriptPath
        ? [parseTranscript(provider, transcriptPath)].filter(isPresent)
        : discoverHistory(provider);
      const uploadSessions = sessions.flatMap(chunkSessionEntries);
      const uploadBatches = chunkUploadBatches(uploadSessions);
      let uploadedSessions = 0;
      for (const batch of uploadBatches) {
        const batchId = digest(
          JSON.stringify(
            batch.map((session) => [
              session.provider_session_id,
              session.entries.map((entry) => entry.provider_entry_id),
            ]),
          ),
        );
        await api(options, {
          path: `${syncRunsPath(options.teamId, source.sourceId)}/${run.id}/batches`,
          method: "POST",
          body: {
            batch_id: batchId,
            sessions: batch,
            cursor: String(uploadedSessions + batch.length),
          },
        });
        uploadedSessions += batch.length;
      }
      await api(options, {
        path: `${syncRunsPath(options.teamId, source.sourceId)}/${run.id}/complete`,
        method: "POST",
        body: { cursor: String(sessions.length), error: null },
      });
      if (!options.quiet) {
        console.log(
          `${adapters[provider].label}: synchronized ${sessions.length} sessions.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await api(options, {
        path: `${syncRunsPath(options.teamId, source.sourceId)}/${run.id}/complete`,
        method: "POST",
        body: { cursor: null, error: message },
      }).catch(() => undefined);
      throw error;
    }
  }
}

async function status(options: ChatSlurperCommandOptions): Promise<void> {
  const config = readConfiguration();
  if (!config) {
    console.log("Tilde Chat Slurper is not configured on this device.");
    return;
  }
  const response = await api<{ items?: ChatSlurperSource[] }>(options, {
    path: `/api/v1/team/${encodeURIComponent(options.teamId)}/chat-slurper/sources?page_size=100`,
  });
  for (const [provider, local] of Object.entries(config.providers)) {
    if (!local) continue;
    const remote = response.items?.find(
      (source) => source.id === local.sourceId,
    );
    const runs = remote
      ? await api<{ items?: ChatSlurperSyncRun[] }>(options, {
          path: `${syncRunsPath(options.teamId, local.sourceId)}?page_size=1`,
        })
      : undefined;
    const latest = runs?.items?.[0];
    console.log(
      `${adapters[provider as ChatSlurperProvider].label}: ${remote?.status ?? "missing remotely"} -> bank ${local.memoryBankId}${
        latest
          ? `; last sync ${latest.status} (${latest.sessions_processed} sessions, ${latest.entries_processed} entries)${latest.error ? `: ${latest.error}` : ""}`
          : "; no sync runs"
      }`,
    );
  }
}

async function disable(options: ChatSlurperCommandOptions): Promise<void> {
  const config = requiredConfiguration(options);
  const providers = options.provider
    ? [options.provider]
    : (Object.keys(config.providers) as ChatSlurperProvider[]);
  for (const provider of providers) {
    const source = config.providers[provider];
    if (!source) continue;
    await api(options, {
      path: `/api/v1/team/${encodeURIComponent(options.teamId)}/chat-slurper/sources/${source.sourceId}`,
      method: "DELETE",
    });
    removeProviderHooks(provider, homedir());
    delete config.providers[provider];
    console.log(`Disabled ${adapters[provider].label} history capture.`);
  }
  writeConfiguration(config);
}

export async function enqueueCaptureHook(
  provider: ChatSlurperProvider | undefined,
): Promise<void> {
  if (!provider) throw new Error("capture-hook requires --provider.");
  const input = await readStdin();
  const payload = parseObject(input);
  const transcriptPath = stringAt(payload, "transcript_path", "transcriptPath");
  if (!transcriptPath || !existsSync(transcriptPath)) return;
  const queue = queuePath();
  mkdirSync(queue, { recursive: true, mode: 0o700 });
  const queued: QueuedHook = {
    version: 1,
    provider,
    transcriptPath: resolve(transcriptPath),
    queuedAt: new Date().toISOString(),
  };
  atomicWriteJson(join(queue, `${Date.now()}-${randomUUID()}.json`), queued);
  let config: ChatSlurperConfiguration | undefined;
  try {
    config = readConfiguration();
  } catch {
    return;
  }
  if (!config?.providers[provider]) return;
  const cliEntry = process.argv[1];
  if (!cliEntry) return;
  const args = [
    cliEntry,
    "chat-slurper",
    "flush-hooks",
    "--provider",
    provider,
    "--base-url",
    config.baseUrl,
    "--team-id",
    config.teamId,
    "--quiet",
  ];
  if (config.orgId) args.push("--org-id", config.orgId);
  spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
}

async function flushHooks(options: ChatSlurperCommandOptions): Promise<void> {
  const queue = queuePath();
  if (!existsSync(queue)) return;
  const lock = `${queue}.lock`;
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  try {
    const files = readdirSync(queue)
      .filter((file) => file.endsWith(".json"))
      .sort();
    for (const file of files) {
      const path = join(queue, file);
      let queued: QueuedHook;
      try {
        queued = parseQueuedHook(readFileSync(path, "utf8"));
      } catch {
        renameSync(path, `${path}.invalid`);
        continue;
      }
      if (options.provider && queued.provider !== options.provider) continue;
      if (!existsSync(queued.transcriptPath)) {
        rmSync(path);
        continue;
      }
      await backfill(
        { ...options, provider: queued.provider },
        "live",
        queued.transcriptPath,
      );
      rmSync(path);
    }
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function discoverHistory(
  provider: ChatSlurperProvider,
): NormalizedHistorySession[] {
  const root = adapters[provider].historyRoot(homedir());
  if (!existsSync(root)) return [];
  return jsonlFiles(root)
    .map((path) => parseTranscript(provider, path))
    .filter(isPresent)
    .sort((left, right) => left.started_at.localeCompare(right.started_at));
}

export function parseTranscript(
  provider: ChatSlurperProvider,
  path: string,
): NormalizedHistorySession | undefined {
  if (!existsSync(path)) return undefined;
  if (statSync(path).size > MAX_TRANSCRIPT_BYTES) {
    throw new Error(
      `Transcript exceeds ${MAX_TRANSCRIPT_BYTES} bytes: ${path}`,
    );
  }
  const lines = readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line, index) => parseJsonObjectStrict(line, `${path}:${index + 1}`));
  if (lines.length === 0) return undefined;
  const fileTime = statSync(path).mtime.toISOString();
  return provider === "codex"
    ? parseCodex(lines, path, fileTime)
    : parseClaude(lines, path, fileTime);
}

function parseCodex(
  lines: Record<string, unknown>[],
  path: string,
  fallbackTime: string,
): NormalizedHistorySession | undefined {
  const metaLine = lines.find((line) => line.type === "session_meta");
  const meta = objectAt(metaLine, "payload");
  const entries: NormalizedHistoryEntry[] = [];
  const contextModel = [...lines]
    .reverse()
    .filter((line) => line.type === "turn_context")
    .map((line) => stringAt(objectAt(line, "payload"), "model"))
    .find(isPresent);
  lines.forEach((line, lineIndex) => {
    if (line.type !== "response_item") return;
    const payload = objectAt(line, "payload");
    const payloadType = stringAt(payload, "type");
    const role = stringAt(payload, "role");
    if (payloadType === "message" && role !== "user" && role !== "assistant")
      return;
    const entryType =
      payloadType === "function_call"
        ? "tool_call"
        : payloadType === "function_call_output"
          ? "tool_result"
          : payloadType === "message"
            ? "message"
            : undefined;
    if (!entryType) return;
    const rawContent =
      entryType === "message"
        ? messageContent(payload.content)
        : JSON.stringify({
            name: stringAt(payload, "name"),
            call_id: stringAt(payload, "call_id"),
            arguments: payload.arguments,
            output: payload.output,
          });
    const content = boundedRedacted(rawContent);
    if (!content) return;
    entries.push({
      provider_entry_id:
        stringAt(payload, "id", "call_id") ??
        digest(`${path}:${lineIndex}:${role ?? entryType}:${content}`),
      sequence: entries.length,
      entry_type: entryType,
      actor: {
        kind:
          role === "user"
            ? "human"
            : entryType === "message"
              ? "agent"
              : "tool",
        ...(role ? { role } : {}),
      },
      content,
      occurred_at: isoTime(stringAt(line, "timestamp"), fallbackTime),
      metadata: {
        provider_record_type: "response_item",
        provider_payload_type: payloadType,
      },
    });
  });
  if (entries.length === 0) return undefined;
  const cwd = stringAt(meta, "cwd");
  const git = objectAt(meta, "git");
  const gitRemote = stringAt(git, "repository_url", "remote");
  const branch = stringAt(git, "branch");
  const headSha = stringAt(git, "commit_hash", "head_sha");
  const model = contextModel ?? stringAt(meta, "model");
  const startedAt = isoTime(stringAt(metaLine, "timestamp"), fallbackTime);
  return {
    provider_session_id: stringAt(meta, "id") ?? digest(path),
    started_at: startedAt,
    last_activity_at: entries.at(-1)?.occurred_at ?? startedAt,
    ...(cwd ? { working_directory: cwd, repository: basename(cwd) } : {}),
    ...(gitRemote ? { git_remote: gitRemote } : {}),
    ...(branch ? { branch } : {}),
    ...(headSha ? { head_sha: headSha } : {}),
    agent_name: "codex",
    ...(model ? { model } : {}),
    metadata: { transcript_path: path, provider: "codex" },
    entries,
  };
}

function parseClaude(
  lines: Record<string, unknown>[],
  path: string,
  fallbackTime: string,
): NormalizedHistorySession | undefined {
  const entries: NormalizedHistoryEntry[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    if (line.type !== "user" && line.type !== "assistant") continue;
    const message = objectAt(line, "message");
    const role = stringAt(message, "role") ?? String(line.type);
    const content = boundedRedacted(messageContent(message.content));
    if (!content) continue;
    entries.push({
      provider_entry_id:
        stringAt(line, "uuid", "id") ??
        digest(`${path}:${lineIndex}:${role}:${content}`),
      sequence: entries.length,
      entry_type: "message",
      actor: { kind: role === "user" ? "human" : "agent", role },
      content,
      occurred_at: isoTime(stringAt(line, "timestamp"), fallbackTime),
      metadata: { provider_record_type: String(line.type) },
    });
  }
  if (entries.length === 0) return undefined;
  const first = lines[0] ?? {};
  const cwd = lines.map((line) => stringAt(line, "cwd")).find(isPresent);
  const startedAt = entries[0]?.occurred_at ?? fallbackTime;
  const branch = lines
    .map((line) => stringAt(line, "gitBranch"))
    .find(isPresent);
  const model = lines
    .map((line) => stringAt(objectAt(line, "message"), "model"))
    .find(isPresent);
  return {
    provider_session_id:
      lines.map((line) => stringAt(line, "sessionId")).find(isPresent) ??
      digest(path),
    started_at: startedAt,
    last_activity_at: entries.at(-1)?.occurred_at ?? startedAt,
    ...(cwd ? { working_directory: cwd, repository: basename(cwd) } : {}),
    ...(branch ? { branch } : {}),
    agent_name: "claude-code",
    ...(model ? { model } : {}),
    metadata: {
      transcript_path: path,
      provider: "claude-code",
      version: stringAt(first, "version"),
    },
    entries,
  };
}

export function installProviderHooks(
  provider: ChatSlurperProvider,
  home: string,
): void {
  const adapter = adapters[provider];
  const path = adapter.hookFile(home);
  const root = existsSync(path)
    ? parseJsonObjectStrict(readFileSync(path, "utf8"), path)
    : {};
  const hooks = hookMap(root, path);
  const command = hookCommand(adapter.id);
  for (const event of adapter.hookEvents) {
    const matchers = Array.isArray(hooks[event]) ? [...hooks[event]] : [];
    if (!matchers.some((matcher) => matcherContainsCommand(matcher, command))) {
      matchers.push({
        matcher: "",
        hooks: [{ type: "command", command, timeout: 5 }],
      });
    }
    hooks[event] = matchers;
  }
  root.hooks = hooks;
  atomicWriteJson(path, root);
}

export function removeProviderHooks(
  provider: ChatSlurperProvider,
  home: string,
): void {
  const adapter = adapters[provider];
  const path = adapter.hookFile(home);
  if (!existsSync(path)) return;
  const root = parseJsonObjectStrict(readFileSync(path, "utf8"), path);
  const hooks = hookMap(root, path);
  const command = hookCommand(adapter.id);
  for (const event of adapter.hookEvents) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = hooks[event].flatMap((matcher) => {
      const record = parseObject(matcher);
      if (!Array.isArray(record.hooks)) return [matcher];
      const retained = record.hooks.filter((hook) => {
        const candidate = parseObject(hook);
        return candidate.type !== "command" || candidate.command !== command;
      });
      return retained.length > 0 ? [{ ...record, hooks: retained }] : [];
    });
    if ((hooks[event] as unknown[]).length === 0) delete hooks[event];
  }
  root.hooks = hooks;
  atomicWriteJson(path, root);
}

function validateHookFile(adapter: ProviderAdapter, home: string): void {
  const path = adapter.hookFile(home);
  if (existsSync(path)) {
    const root = parseJsonObjectStrict(readFileSync(path, "utf8"), path);
    hookMap(root, path);
  }
}

function hookMap(
  root: Record<string, unknown>,
  path: string,
): Record<string, unknown> {
  if (root.hooks === undefined) return {};
  if (
    !root.hooks ||
    typeof root.hooks !== "object" ||
    Array.isArray(root.hooks)
  ) {
    throw new Error(`Invalid hooks object in ${path}`);
  }
  const hooks = root.hooks as Record<string, unknown>;
  for (const [event, matchers] of Object.entries(hooks)) {
    if (!Array.isArray(matchers)) {
      throw new Error(`Invalid ${event} hook list in ${path}`);
    }
  }
  return hooks;
}

function matcherContainsCommand(input: unknown, command: string): boolean {
  const matcher = parseObject(input);
  return (
    Array.isArray(matcher.hooks) &&
    matcher.hooks.some((hook) => {
      const candidate = parseObject(hook);
      return candidate.type === "command" && candidate.command === command;
    })
  );
}

function hookCommand(provider: ChatSlurperProvider): string {
  return `tilde chat-slurper capture-hook --provider ${provider} --quiet`;
}

function requiredConfiguration(
  options: ChatSlurperCommandOptions,
): ChatSlurperConfiguration {
  const config = readConfiguration();
  if (!config)
    throw new Error(
      "Tilde Chat Slurper is not configured. Run `tilde chat-slurper configure`.",
    );
  if (
    config.baseUrl !== options.baseUrl ||
    config.teamId !== options.teamId ||
    (config.orgId !== undefined && config.orgId !== options.orgId)
  ) {
    throw new Error(
      "The selected Tilde team does not match this device's Chat Slurper configuration.",
    );
  }
  return config;
}

function readConfiguration(): ChatSlurperConfiguration | undefined {
  const path = configurationPath();
  if (!existsSync(path)) return undefined;
  const value = parseJsonObjectStrict(readFileSync(path, "utf8"), path);
  if (
    value.version !== 1 ||
    !stringAt(value, "baseUrl") ||
    !stringAt(value, "teamId") ||
    !value.providers ||
    typeof value.providers !== "object" ||
    Array.isArray(value.providers)
  ) {
    throw new Error(`Invalid Chat Slurper configuration in ${path}`);
  }
  const providers = value.providers as Record<string, unknown>;
  for (const [provider, raw] of Object.entries(providers)) {
    if (provider !== "codex" && provider !== "claude-code") {
      throw new Error(`Unknown Chat Slurper provider ${provider} in ${path}`);
    }
    const config = parseObject(raw);
    if (
      !stringAt(config, "sourceId") ||
      !stringAt(config, "memoryBankId") ||
      !stringAt(config, "configuredAt") ||
      !stringAt(config, "hookFile")
    ) {
      throw new Error(
        `Invalid ${provider} Chat Slurper configuration in ${path}`,
      );
    }
  }
  return value as ChatSlurperConfiguration;
}

function writeConfiguration(config: ChatSlurperConfiguration): void {
  atomicWriteJson(configurationPath(), config);
}

function configurationPath(): string {
  return (
    process.env.TILDE_CHAT_SLURPER_CONFIG_PATH ??
    join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
      "tilde",
      "chat-slurper.json",
    )
  );
}

function stableDeviceId(): string {
  return digest(`${hostname()}:${homedir()}`).slice(0, 32);
}

function syncRunsPath(teamId: string, sourceId: string): string {
  return `/api/v1/team/${encodeURIComponent(teamId)}/chat-slurper/sources/${sourceId}/sync-runs`;
}

async function api<T = unknown>(
  options: ChatSlurperCommandOptions,
  request: { path: string; method?: string; body?: unknown },
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(new URL(request.path, options.baseUrl), {
        method: request.method ?? "GET",
        headers: {
          Authorization: `Bearer ${options.accessToken}`,
          ...(options.orgId ? { "x-tilde-org-id": options.orgId } : {}),
          ...(request.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(request.body === undefined
          ? {}
          : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
      if (response.ok) {
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }
      const message = `${request.path} failed (${response.status}): ${await response.text()}`;
      if (response.status !== 429 && response.status < 500)
        throw new Error(message);
      lastError = new Error(message);
    } catch (error) {
      lastError = error;
      if (error instanceof Error && /failed \(4\d\d\)/u.test(error.message))
        throw error;
    }
    if (attempt < 2)
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, 250 * 2 ** attempt),
      );
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function jsonlFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        if (files.length >= MAX_TRANSCRIPT_FILES) {
          throw new Error(
            `History contains more than ${MAX_TRANSCRIPT_FILES} transcript files.`,
          );
        }
        if (entry.isSymbolicLink()) continue;
        files.push(child);
      }
    }
  };
  visit(resolve(root));
  return files;
}

function chunkSessionEntries(
  session: NormalizedHistorySession,
): NormalizedHistorySession[] {
  const chunkSize = 10;
  if (session.entries.length <= chunkSize) return [session];
  const chunks: NormalizedHistorySession[] = [];
  for (let index = 0; index < session.entries.length; index += chunkSize) {
    chunks.push({
      ...session,
      entries: session.entries.slice(index, index + chunkSize),
    });
  }
  return chunks;
}

function chunkUploadBatches(
  sessions: NormalizedHistorySession[],
): NormalizedHistorySession[][] {
  const batches: NormalizedHistorySession[][] = [];
  let batch: NormalizedHistorySession[] = [];
  for (const session of sessions) {
    const candidate = [...batch, session];
    if (
      serializedSessionsBytes(candidate) > MAX_UPLOAD_BATCH_BYTES &&
      batch.length > 0
    ) {
      batches.push(batch);
      batch = [session];
    } else {
      batch = candidate;
    }
    if (serializedSessionsBytes(batch) > MAX_UPLOAD_BATCH_BYTES) {
      throw new Error(
        `A normalized session exceeds the ${MAX_UPLOAD_BATCH_BYTES}-byte upload limit.`,
      );
    }
    if (batch.length === 10) {
      batches.push(batch);
      batch = [];
    }
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function serializedSessionsBytes(sessions: NormalizedHistorySession[]): number {
  return Buffer.byteLength(JSON.stringify({ sessions }), "utf8");
}

function messageContent(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const text = stringAt(record, "text", "input_text", "output_text");
    if (text) return [text];
    if (record.type === "tool_use" || record.type === "tool_result") {
      return [JSON.stringify(record)];
    }
    return [];
  });
  const content = parts.join("\n").trim();
  return content || undefined;
}

function boundedRedacted(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const redacted = value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu, "Bearer [REDACTED]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\b(\s*[=:]\s*|["']\s*:\s*["'])[^\s,"'}]+/giu,
      (_match, key: string, separator: string) =>
        `${key}${separator}[REDACTED]`,
    );
  return Buffer.byteLength(redacted, "utf8") <= MAX_ENTRY_CONTENT_BYTES
    ? redacted
    : `${Buffer.from(redacted).subarray(0, MAX_ENTRY_CONTENT_BYTES).toString("utf8")}\n[TRUNCATED]`;
}

function parseObject(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    try {
      return parseObject(JSON.parse(input));
    } catch {
      return {};
    }
  }
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function parseJsonObjectStrict(
  input: string,
  label: string,
): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(input);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("root value must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${label}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

function parseQueuedHook(input: string): QueuedHook {
  const value = parseJsonObjectStrict(input, "Chat Slurper hook queue item");
  const provider = stringAt(value, "provider");
  const transcriptPath = stringAt(value, "transcriptPath");
  if ((provider !== "codex" && provider !== "claude-code") || !transcriptPath) {
    throw new Error("Invalid Chat Slurper hook queue item");
  }
  return {
    version: 1,
    provider,
    transcriptPath,
    queuedAt: stringAt(value, "queuedAt") ?? new Date(0).toISOString(),
  };
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function queuePath(): string {
  return (
    process.env.TILDE_CHAT_SLURPER_QUEUE_PATH ??
    join(
      process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
      "tilde",
      "chat-slurper",
      "queue",
    )
  );
}

function objectAt(input: unknown, key: string): Record<string, unknown> {
  return parseObject(parseObject(input)[key]);
}

function stringAt(input: unknown, ...keys: string[]): string | undefined {
  const record = parseObject(input);
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function isoTime(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? fallback : date.toISOString();
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
