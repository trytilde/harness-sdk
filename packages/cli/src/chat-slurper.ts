import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import {
  type ChatSlurperRedactionConfiguration,
  redactJsonValues,
  redactText,
  validateRedactionConfiguration,
} from "./chat-slurper-redaction";

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
  hookEvent?: string;
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

export type QueuedHook = {
  version: 1;
  provider: ChatSlurperProvider;
  transcriptPath: string;
  hookEvent: string;
  queuedAt: string;
  attempts?: number;
  lastAttemptAt?: string;
  lastError?: string;
};

type ChatSlurperConfiguration = {
  version: 1;
  baseUrl: string;
  orgId?: string;
  teamId: string;
  providers: Partial<Record<ChatSlurperProvider, ProviderConfiguration>>;
  redaction?: ChatSlurperRedactionConfiguration;
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
  raw_transcript?: string;
  raw_transcript_sha256?: string;
  prompts?: string[];
  assets?: NormalizedHistoryAsset[];
  entries: NormalizedHistoryEntry[];
};

export type NormalizedHistoryAsset = {
  provider_asset_id: string;
  media_type: string;
  data_base64: string;
  sha256: string;
  metadata: Record<string, unknown>;
};

type ProviderAdapter = {
  id: ChatSlurperProvider;
  label: string;
  historyRoot(home: string): string;
  hookFile(home: string): string;
  hooks: Array<{ event: string; matcher?: string }>;
};

const adapters: Record<ChatSlurperProvider, ProviderAdapter> = {
  codex: {
    id: "codex",
    label: "Codex / Codex Desktop",
    historyRoot: (home) => join(home, ".codex", "sessions"),
    hookFile: (home) => join(home, ".codex", "hooks.json"),
    hooks: [
      { event: "SessionStart" },
      { event: "UserPromptSubmit" },
      { event: "PreToolUse" },
      { event: "PostToolUse" },
      { event: "Stop" },
    ],
  },
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    historyRoot: (home) => join(home, ".claude", "projects"),
    hookFile: (home) => join(home, ".claude", "settings.json"),
    hooks: [
      { event: "SessionStart" },
      { event: "UserPromptSubmit" },
      { event: "PreToolUse", matcher: "Task" },
      { event: "PostToolUse", matcher: "Task" },
      { event: "PostToolUse", matcher: "TodoWrite" },
      { event: "Stop" },
      { event: "SessionEnd" },
    ],
  },
};

const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024;
const MAX_TRANSCRIPT_FILES = 10_000;
const MAX_DISCOVERED_HISTORY_BYTES = 256 * 1024 * 1024;
const MAX_HOOK_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_ENTRY_CONTENT_BYTES = 64 * 1024;
const MAX_UPLOAD_BATCH_BYTES = 12_500_000;
const API_TIMEOUT_MS = 30_000;
const MAX_QUEUE_ATTEMPTS = 3;
const STALE_LOCK_AGE_MS = 10 * 60 * 1000;

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
      await enqueueCaptureHook(options.provider, options.hookEvent);
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
  capture?: { events: string[]; latestQueuedAt: string },
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
      const parsedSessions = transcriptPath
        ? [parseTranscript(provider, transcriptPath, config.redaction)].filter(
            isPresent,
          )
        : discoverHistory(provider, config.redaction);
      const sessions = capture
        ? parsedSessions.map((session) => ({
            ...session,
            metadata: {
              ...session.metadata,
              capture_events: [...new Set(capture.events)],
              captured_at: capture.latestQueuedAt,
            },
          }))
        : parsedSessions;
      const uploadSessions = sessions.flatMap(chunkSessionEntries);
      const uploadBatches = chunkUploadBatches(uploadSessions);
      let uploadedSessions = 0;
      for (const batch of uploadBatches) {
        const batchId = digest(
          JSON.stringify(
            batch.map((session) => [
              session.provider_session_id,
              session.entries.map((entry) => entry.provider_entry_id),
              session.raw_transcript_sha256,
              session.assets?.map((asset) => [
                asset.provider_asset_id,
                asset.sha256,
              ]),
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
  configuredEvent?: string,
): Promise<void> {
  if (!provider) throw new Error("capture-hook requires --provider.");
  const input = await readStdin();
  const payload = parseObject(input);
  const transcriptPath = stringAt(payload, "transcript_path", "transcriptPath");
  if (!transcriptPath || !existsSync(transcriptPath)) return;
  const canonicalTranscriptPath = realpathSync(transcriptPath);
  const historyRoot = adapters[provider].historyRoot(homedir());
  if (
    !existsSync(historyRoot) ||
    !isWithin(historyRoot, canonicalTranscriptPath)
  )
    return;
  const payloadEvent = stringAt(payload, "hook_event_name", "hookEventName");
  const hookEvent = validHookEvent(payloadEvent)
    ? payloadEvent
    : validHookEvent(configuredEvent)
      ? configuredEvent
      : "unknown";
  const queue = queuePath();
  mkdirSync(queue, { recursive: true, mode: 0o700 });
  const queued: QueuedHook = {
    version: 1,
    provider,
    transcriptPath: canonicalTranscriptPath,
    hookEvent,
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
  if (!acquireQueueLock(lock)) return;
  try {
    const files = readdirSync(queue)
      .filter((file) => file.endsWith(".json"))
      .sort();
    const valid: Array<{ file: string; queued: QueuedHook }> = [];
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
      const providerRoot = adapters[queued.provider].historyRoot(homedir());
      if (
        !existsSync(providerRoot) ||
        !isWithin(providerRoot, realpathSync(queued.transcriptPath))
      ) {
        renameSync(path, `${path}.invalid`);
        continue;
      }
      valid.push({ file: path, queued });
    }
    for (const items of coalesceQueuedHooks(valid)) {
      const queued = items.at(-1)?.queued;
      if (!queued) continue;
      try {
        await backfill(
          { ...options, provider: queued.provider },
          "live",
          queued.transcriptPath,
          {
            events: items.map((item) => item.queued.hookEvent),
            latestQueuedAt: queued.queuedAt,
          },
        );
        for (const item of items) rmSync(item.file);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const item of items) {
          const attempts = (item.queued.attempts ?? 0) + 1;
          const updated: QueuedHook = {
            ...item.queued,
            attempts,
            lastAttemptAt: new Date().toISOString(),
            lastError: message.slice(0, 2_048),
          };
          if (attempts >= MAX_QUEUE_ATTEMPTS) {
            atomicWriteJson(`${item.file}.failed`, updated);
            rmSync(item.file);
          } else {
            atomicWriteJson(item.file, updated);
          }
        }
      }
    }
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Acquire a process-owned queue lock and reclaim locks left by dead processes. */
export function acquireQueueLock(lock: string): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      try {
        atomicWriteJson(join(lock, "owner.json"), {
          pid: process.pid,
          hostname: hostname(),
          createdAt: new Date().toISOString(),
        });
      } catch (error) {
        rmSync(lock, { recursive: true, force: true });
        throw error;
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!isStaleQueueLock(lock)) return false;
      const abandoned = `${lock}.stale.${process.pid}.${randomUUID()}`;
      try {
        renameSync(lock, abandoned);
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw renameError;
      }
      rmSync(abandoned, { recursive: true, force: true });
    }
  }
  return false;
}

function isStaleQueueLock(lock: string): boolean {
  const ownerPath = join(lock, "owner.json");
  try {
    const owner = parseJsonObjectStrict(
      readFileSync(ownerPath, "utf8"),
      ownerPath,
    );
    const pid = owner.pid;
    if (owner.hostname === hostname() && typeof pid === "number") {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    }
  } catch {
    // A crash between mkdir and writing owner metadata is reclaimed by age.
  }
  return Date.now() - statSync(lock).mtimeMs > STALE_LOCK_AGE_MS;
}

/** Coalesce lifecycle triggers without dropping the queue files covered by a sync. */
export function coalesceQueuedHooks(
  items: Array<{ file: string; queued: QueuedHook }>,
): Array<Array<{ file: string; queued: QueuedHook }>> {
  const grouped = new Map<
    string,
    Array<{ file: string; queued: QueuedHook }>
  >();
  for (const item of items) {
    const key = `${item.queued.provider}\u0000${item.queued.transcriptPath}`;
    grouped.set(key, [...(grouped.get(key) ?? []), item]);
  }
  return [...grouped.values()];
}

export function discoverHistory(
  provider: ChatSlurperProvider,
  redaction?: ChatSlurperRedactionConfiguration,
): NormalizedHistorySession[] {
  const root = adapters[provider].historyRoot(homedir());
  if (!existsSync(root)) return [];
  return jsonlFiles(root)
    .map((path) => parseTranscript(provider, path, redaction))
    .filter(isPresent)
    .sort((left, right) => left.started_at.localeCompare(right.started_at));
}

export function parseTranscript(
  provider: ChatSlurperProvider,
  path: string,
  redaction?: ChatSlurperRedactionConfiguration,
): NormalizedHistorySession | undefined {
  if (!existsSync(path)) return undefined;
  if (statSync(path).size > MAX_TRANSCRIPT_BYTES) {
    throw new Error(
      `Transcript exceeds ${MAX_TRANSCRIPT_BYTES} bytes: ${path}`,
    );
  }
  const parsedLines = readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line, index) => parseJsonObjectStrict(line, `${path}:${index + 1}`));
  const assets: NormalizedHistoryAsset[] = [];
  const withoutImages = parsedLines.map((line) =>
    extractEmbeddedImages(line, assets),
  );
  const lines = redactJsonValues(withoutImages, redaction);
  if (lines.length === 0) return undefined;
  const fileTime = statSync(path).mtime.toISOString();
  const session =
    provider === "codex"
      ? parseCodex(lines, path, fileTime)
      : parseClaude(lines, path, fileTime);
  if (!session) return undefined;
  const rawTranscript = `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
  const prompts = session.entries
    .filter(
      (entry) =>
        entry.actor.kind === "human" && typeof entry.content === "string",
    )
    .map((entry) => entry.content as string);
  return {
    ...session,
    raw_transcript: rawTranscript,
    raw_transcript_sha256: digest(rawTranscript),
    prompts,
    assets,
  };
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
    metadata: {
      transcript_path: redactText(path, undefined),
      provider: "codex",
    },
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
    const baseId =
      stringAt(line, "uuid", "id") ?? digest(`${path}:${lineIndex}:${role}`);
    const parts = claudeMessageParts(message.content);
    for (const [partIndex, part] of parts.entries()) {
      const content = boundedRedacted(part.content);
      if (!content) continue;
      entries.push({
        provider_entry_id: `${baseId}:${partIndex}`,
        sequence: entries.length,
        entry_type: part.entryType,
        actor: {
          kind:
            part.entryType === "message"
              ? role === "user"
                ? "human"
                : "agent"
              : part.entryType === "asset"
                ? "attachment"
                : "tool",
          role,
        },
        content,
        occurred_at: isoTime(stringAt(line, "timestamp"), fallbackTime),
        metadata: {
          provider_record_type: String(line.type),
          ...(part.toolName ? { tool_name: part.toolName } : {}),
        },
      });
    }
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
      transcript_path: redactText(path, undefined),
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
  for (const event of new Set(adapter.hooks.map((hook) => hook.event))) {
    const matchers = hooks[event];
    if (!Array.isArray(matchers)) continue;
    const retained = withoutTildeCommands(matchers, provider);
    if (retained.length > 0) hooks[event] = retained;
    else delete hooks[event];
  }
  for (const spec of adapter.hooks) {
    const command = hookCommand(adapter.id, spec.event);
    const existing = hooks[spec.event];
    const matchers: unknown[] = Array.isArray(existing) ? [...existing] : [];
    if (
      !matchers.some(
        (matcher) =>
          parseObject(matcher).matcher === (spec.matcher ?? "") &&
          matcherContainsCommand(matcher, command),
      )
    ) {
      matchers.push({
        matcher: spec.matcher ?? "",
        hooks: [{ type: "command", command, timeout: 5 }],
      });
    }
    hooks[spec.event] = matchers;
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
  for (const event of new Set(adapter.hooks.map((hook) => hook.event))) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = withoutTildeCommands(hooks[event], provider);
    if ((hooks[event] as unknown[]).length === 0) delete hooks[event];
  }
  root.hooks = hooks;
  atomicWriteJson(path, root);
}

function withoutTildeCommands(
  matchers: unknown[],
  provider: ChatSlurperProvider,
): unknown[] {
  return matchers.flatMap((matcher) => {
    const record = parseObject(matcher);
    if (!Array.isArray(record.hooks)) return [matcher];
    const retained = record.hooks.filter((hook) => {
      const candidate = parseObject(hook);
      return (
        candidate.type !== "command" ||
        !isTildeHookCommand(candidate.command, provider)
      );
    });
    return retained.length > 0 ? [{ ...record, hooks: retained }] : [];
  });
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

function hookCommand(provider: ChatSlurperProvider, event: string): string {
  return `tilde chat-slurper capture-hook --provider ${provider} --hook-event ${event} --quiet`;
}

function isTildeHookCommand(
  command: unknown,
  provider: ChatSlurperProvider,
): boolean {
  return (
    typeof command === "string" &&
    command.startsWith(
      `tilde chat-slurper capture-hook --provider ${provider} `,
    )
  );
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
  validateRedactionConfiguration(
    value.redaction as ChatSlurperRedactionConfiguration | undefined,
  );
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
  return `/api/v1/team/${encodeURIComponent(teamId)}/chat-slurper/sources/${encodeURIComponent(sourceId)}/sync-runs`;
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
  let totalBytes = 0;
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
        const bytes = statSync(child).size;
        totalBytes += bytes;
        if (totalBytes > MAX_DISCOVERED_HISTORY_BYTES) {
          throw new Error(
            `History exceeds the ${MAX_DISCOVERED_HISTORY_BYTES}-byte local processing limit. Backfill providers separately or remove unwanted transcripts.`,
          );
        }
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
    const {
      raw_transcript,
      raw_transcript_sha256,
      prompts,
      assets,
      ...common
    } = session;
    chunks.push({
      ...common,
      ...(index === 0
        ? {
            ...(raw_transcript ? { raw_transcript } : {}),
            ...(raw_transcript_sha256 ? { raw_transcript_sha256 } : {}),
            ...(prompts ? { prompts } : {}),
            ...(assets ? { assets } : {}),
          }
        : {}),
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
    const assetId = stringAt(record, "asset_id");
    if (assetId) return [`[image:${assetId}]`];
    if (record.type === "tool_use" || record.type === "tool_result") {
      return [JSON.stringify(record)];
    }
    return [];
  });
  const content = parts.join("\n").trim();
  return content || undefined;
}

function claudeMessageParts(
  value: unknown,
): Array<{ entryType: string; content: string; toolName?: string }> {
  if (typeof value === "string")
    return value.trim() ? [{ entryType: "message", content: value }] : [];
  if (!Array.isArray(value)) return [];
  const parts: Array<{
    entryType: string;
    content: string;
    toolName?: string;
  }> = [];
  const text: string[] = [];
  const flushText = () => {
    const content = text.splice(0).join("\n").trim();
    if (content) parts.push({ entryType: "message", content });
  };
  for (const item of value) {
    const record = parseObject(item);
    const itemText = stringAt(record, "text", "input_text", "output_text");
    if (itemText) {
      text.push(itemText);
      continue;
    }
    if (record.type === "tool_use" || record.type === "tool_result") {
      flushText();
      const toolName = stringAt(record, "name");
      parts.push({
        entryType: record.type === "tool_use" ? "tool_call" : "tool_result",
        content: JSON.stringify(record),
        ...(toolName ? { toolName } : {}),
      });
      continue;
    }
    const assetId = stringAt(record, "asset_id");
    if (assetId) {
      flushText();
      parts.push({ entryType: "asset", content: `[image:${assetId}]` });
    }
  }
  flushText();
  return parts;
}

function boundedRedacted(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const redacted = redactText(value, undefined);
  return Buffer.byteLength(redacted, "utf8") <= MAX_ENTRY_CONTENT_BYTES
    ? redacted
    : `${Buffer.from(redacted).subarray(0, MAX_ENTRY_CONTENT_BYTES).toString("utf8")}\n[TRUNCATED]`;
}

function extractEmbeddedImages<T>(
  value: T,
  assets: NormalizedHistoryAsset[],
): T {
  if (typeof value === "string") {
    return extractImageDataUris(value, assets) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => extractEmbeddedImages(item, assets)) as T;
  }
  if (!value || typeof value !== "object") return value;
  const record = { ...(value as Record<string, unknown>) };
  const source = parseObject(record.source);
  const sourceData = stringAt(source, "data");
  const sourceMediaType = stringAt(source, "media_type", "mediaType");
  const dataUri = stringAt(record, "image_url", "url");
  const embedded =
    record.type === "image" &&
    source.type === "base64" &&
    sourceData &&
    sourceMediaType
      ? { data: sourceData, mediaType: sourceMediaType }
      : parseImageDataUri(dataUri);
  if (embedded) {
    const providerAssetId = storeEmbeddedImage(embedded, assets);
    return {
      type: "image",
      asset_id: providerAssetId,
      media_type: embedded.mediaType,
    } as T;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, child]) => [
      key,
      extractEmbeddedImages(child, assets),
    ]),
  ) as T;
}

function extractImageDataUris(
  value: string,
  assets: NormalizedHistoryAsset[],
): string {
  return value.replace(
    /data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})/gu,
    (_match, mediaType: string, data: string) =>
      `tilde-asset:${storeEmbeddedImage({ mediaType, data }, assets)}`,
  );
}

function storeEmbeddedImage(
  embedded: { data: string; mediaType: string },
  assets: NormalizedHistoryAsset[],
): string {
  const canonical = embedded.data.replace(/\s+/gu, "");
  const bytes = Buffer.from(canonical, "base64");
  if (
    bytes.length === 0 ||
    bytes.toString("base64").replace(/=+$/u, "") !==
      canonical.replace(/=+$/u, "")
  ) {
    throw new Error("Transcript contains an invalid embedded image.");
  }
  if (!matchesImageSignature(embedded.mediaType, bytes)) {
    throw new Error(
      `Embedded ${embedded.mediaType} data does not match its declared media type.`,
    );
  }
  const sha256 = digestBuffer(bytes);
  const providerAssetId = `sha256:${sha256}`;
  if (!assets.some((asset) => asset.provider_asset_id === providerAssetId)) {
    assets.push({
      provider_asset_id: providerAssetId,
      media_type: embedded.mediaType,
      data_base64: bytes.toString("base64"),
      sha256,
      metadata: { source: "embedded_transcript" },
    });
  }
  return providerAssetId;
}

function parseImageDataUri(
  value: string | undefined,
): { data: string; mediaType: string } | undefined {
  if (!value) return undefined;
  const match =
    /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/u.exec(
      value,
    );
  return match?.[1] && match[2]
    ? { mediaType: match[1], data: match[2] }
    : undefined;
}

function matchesImageSignature(mediaType: string, content: Buffer): boolean {
  if (mediaType === "image/png")
    return content
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mediaType === "image/jpeg")
    return (
      content.length >= 3 &&
      content[0] === 0xff &&
      content[1] === 0xd8 &&
      content[2] === 0xff
    );
  if (mediaType === "image/gif") {
    const signature = content.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  if (mediaType === "image/webp")
    return (
      content.subarray(0, 4).toString("ascii") === "RIFF" &&
      content.subarray(8, 12).toString("ascii") === "WEBP"
    );
  return false;
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
  const lastAttemptAt = stringAt(value, "lastAttemptAt");
  const lastError = stringAt(value, "lastError");
  return {
    version: 1,
    provider,
    transcriptPath,
    hookEvent: stringAt(value, "hookEvent") ?? "unknown",
    queuedAt: stringAt(value, "queuedAt") ?? new Date(0).toISOString(),
    attempts:
      typeof value.attempts === "number" &&
      Number.isInteger(value.attempts) &&
      value.attempts >= 0
        ? value.attempts
        : 0,
    ...(lastAttemptAt ? { lastAttemptAt } : {}),
    ...(lastError ? { lastError } : {}),
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

function digestBuffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_HOOK_INPUT_BYTES) {
      throw new Error(`Hook input exceeds ${MAX_HOOK_INPUT_BYTES} bytes.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function validHookEvent(value: string | undefined): value is string {
  return Boolean(
    value && value.length <= 64 && /^[A-Za-z][A-Za-z0-9]*$/u.test(value),
  );
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(realpathSync(root), candidate);
  return (
    child !== "" &&
    !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    child !== ".." &&
    !isAbsolute(child)
  );
}
