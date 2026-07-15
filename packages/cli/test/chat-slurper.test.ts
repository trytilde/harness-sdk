import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireQueueLock,
  coalesceQueuedHooks,
  installProviderHooks,
  parseTranscript,
  removeProviderHooks,
} from "../src/chat-slurper";
import { redactJsonValues, redactText } from "../src/chat-slurper-redaction";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("chat-slurper hook configuration", () => {
  it("refuses live queue locks and reclaims locks owned by dead processes", () => {
    const root = temporaryDirectory();
    const lock = join(root, "queue.lock");

    expect(acquireQueueLock(lock)).toBe(true);
    expect(acquireQueueLock(lock)).toBe(false);
    rmSync(lock, { recursive: true, force: true });

    mkdirSync(lock);
    writeFileSync(
      join(lock, "owner.json"),
      JSON.stringify({
        pid: 99_999_999,
        hostname: hostname(),
        createdAt: "2026-07-15T12:00:00Z",
      }),
    );
    expect(acquireQueueLock(lock)).toBe(true);
  });

  it("coalesces lifecycle triggers by provider and transcript", () => {
    const queued = (
      provider: "codex" | "claude-code",
      transcriptPath: string,
      hookEvent: string,
    ) => ({
      version: 1 as const,
      provider,
      transcriptPath,
      hookEvent,
      queuedAt: "2026-07-15T12:00:00Z",
    });

    const groups = coalesceQueuedHooks([
      {
        file: "1.json",
        queued: queued("codex", "/tmp/a.jsonl", "UserPromptSubmit"),
      },
      { file: "2.json", queued: queued("codex", "/tmp/a.jsonl", "Stop") },
      { file: "3.json", queued: queued("claude-code", "/tmp/a.jsonl", "Stop") },
    ]);

    expect(groups.map((group) => group.map((item) => item.file))).toEqual([
      ["1.json", "2.json"],
      ["3.json"],
    ]);
  });

  it("installs exactly one Tilde command when configured repeatedly", () => {
    const home = temporaryDirectory();

    installProviderHooks("codex", home);
    installProviderHooks("codex", home);

    const hooksFile = join(home, ".codex", "hooks.json");
    const configured = JSON.parse(readFileSync(hooksFile, "utf8")) as {
      hooks: Record<
        string,
        Array<{ matcher: string; hooks: Array<{ command?: string }> }>
      >;
    };
    const commands = Object.values(configured.hooks)
      .flatMap((matchers) => matchers.flatMap((matcher) => matcher.hooks))
      .map((hook) => hook.command)
      .filter((command) => command?.includes("tilde chat-slurper"));
    expect(commands).toEqual([
      "tilde chat-slurper capture-hook --provider codex --hook-event SessionStart --quiet",
      "tilde chat-slurper capture-hook --provider codex --hook-event UserPromptSubmit --quiet",
      "tilde chat-slurper capture-hook --provider codex --hook-event PreToolUse --quiet",
      "tilde chat-slurper capture-hook --provider codex --hook-event PostToolUse --quiet",
      "tilde chat-slurper capture-hook --provider codex --hook-event Stop --quiet",
    ]);
    expect(Object.keys(configured.hooks)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "Stop",
    ]);
  });

  it("preserves unrelated commands when removing Tilde hooks", () => {
    const home = temporaryDirectory();
    const path = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              matcher: "",
              hooks: [{ type: "command", command: "notify-send done" }],
            },
          ],
        },
      }),
    );

    installProviderHooks("claude-code", home);
    removeProviderHooks("claude-code", home);

    expect(readFileSync(path, "utf8")).toContain("notify-send done");
    expect(readFileSync(path, "utf8")).not.toContain("tilde chat-slurper");
  });

  it("installs Claude task and todo matchers at Entire-compatible depth", () => {
    const home = temporaryDirectory();

    installProviderHooks("claude-code", home);

    const configured = JSON.parse(
      readFileSync(join(home, ".claude", "settings.json"), "utf8"),
    ) as { hooks: Record<string, Array<{ matcher: string }>> };
    expect(Object.keys(configured.hooks)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "Stop",
      "SessionEnd",
    ]);
    expect(configured.hooks.PreToolUse?.map((hook) => hook.matcher)).toEqual([
      "Task",
    ]);
    expect(configured.hooks.PostToolUse?.map((hook) => hook.matcher)).toEqual([
      "Task",
      "TodoWrite",
    ]);
  });

  it("refuses to overwrite malformed provider JSON", () => {
    const home = temporaryDirectory();
    const path = join(home, ".codex", "hooks.json");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(path, "{ definitely-not-json");

    expect(() => installProviderHooks("codex", home)).toThrow(
      `Invalid JSON in ${path}`,
    );
    expect(readFileSync(path, "utf8")).toBe("{ definitely-not-json");
  });
});

describe("chat-slurper redaction", () => {
  it("redacts provider credentials, high entropy values, and connection strings", () => {
    const input = [
      "github_pat_11AA22BB33CC44DD55EE66FF77GG88HH",
      "token=6YpR9qN3vW8sK2mX7zA4cD1fH5jL0uT",
      "postgres://alice:secret@db.example.com/app",
    ].join(" ");

    const redacted = redactText(input, undefined);

    expect(redacted).not.toContain("github_pat_");
    expect(redacted).not.toContain("6YpR9qN3");
    expect(redacted).not.toContain("alice:secret");
  });

  it("supports opt-in PII and custom rules", () => {
    const redacted = redactText(
      "Jane lives at 123 Market Street; jane@example.com; ACCT-4242",
      {
        customPatterns: { internal_account: "ACCT-[0-9]+" },
        pii: { email: true, address: true },
      },
    );

    expect(redacted).toContain("[REDACTED_ADDRESS]");
    expect(redacted).toContain("[REDACTED_EMAIL]");
    expect(redacted).toContain("[REDACTED_INTERNAL_ACCOUNT]");
    expect(() =>
      redactJsonValues([{ text: "aaaaaaaaaaaaaaaa" }], {
        customPatterns: { unsafe: "(a+)+$" },
      }),
    ).toThrow("Unsafe custom redaction rule");
  });

  it("applies OPF spans and fails closed when OPF cannot run", () => {
    const directory = temporaryDirectory();
    const command = join(directory, "opf-fixture");
    writeFileSync(
      command,
      '#!/bin/sh\ncat >/dev/null\nprintf \'%s\' \'{"detected_spans":[{"label":"private_person","start":0,"end":4}]}\'\n',
    );
    chmodSync(command, 0o700);
    const config = {
      openaiPrivacyFilter: {
        enabled: true,
        command,
        categories: ["private_person"],
      },
    };

    expect(
      redactJsonValues([{ text: "John Smith works here" }], config),
    ).toEqual([{ text: "[REDACTED_PERSON] Smith works here" }]);
    expect(() =>
      redactJsonValues([{ text: "John Smith works here" }], {
        openaiPrivacyFilter: {
          enabled: true,
          command: join(directory, "missing-opf"),
        },
      }),
    ).toThrow("failed closed");
  });
});

describe("chat-slurper transcript adapters", () => {
  it("fails loudly on malformed JSONL instead of silently dropping history", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "malformed.jsonl");
    writeFileSync(path, '{"type":"session_meta"}\nnot-json\n');

    expect(() => parseTranscript("codex", path)).toThrow(`${path}:2`);
  });

  it("normalizes Codex metadata and messages", () => {
    const path = fixture("codex.jsonl", [
      {
        timestamp: "2026-07-14T10:00:00Z",
        type: "session_meta",
        payload: {
          id: "codex-123",
          cwd: "/work/receipting",
          model: "gpt-5",
          git: {
            repository_url: "git@github.com:trytilde/receipting.git",
            branch: "codex/receipts",
            commit_hash: "abc123",
          },
        },
      },
      {
        timestamp: "2026-07-14T10:00:30Z",
        type: "turn_context",
        payload: { model: "gpt-5.4" },
      },
      {
        timestamp: "2026-07-14T10:00:40Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [
            { type: "input_text", text: "Internal orchestration instructions" },
          ],
        },
      },
      {
        timestamp: "2026-07-14T10:01:00Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Who owns receipting?" }],
        },
      },
      {
        timestamp: "2026-07-14T10:01:30Z",
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "call-1",
          name: "exec_command",
          arguments: '{"cmd":"rg receipting"}',
        },
      },
      {
        timestamp: "2026-07-14T10:02:00Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Daniel is working on it." }],
        },
      },
    ]);

    const session = parseTranscript("codex", path);

    expect(session).toMatchObject({
      provider_session_id: "codex-123",
      repository: "receipting",
      git_remote: "git@github.com:trytilde/receipting.git",
      branch: "codex/receipts",
      head_sha: "abc123",
      working_directory: "/work/receipting",
      agent_name: "codex",
      model: "gpt-5.4",
    });
    expect(session?.entries).toHaveLength(3);
    expect(session?.entries.map((entry) => entry.entry_type)).toEqual([
      "message",
      "tool_call",
      "message",
    ]);
    expect(
      session?.entries.map((entry) => entry.content).join(" "),
    ).not.toContain("Internal orchestration instructions");
  });

  it("normalizes Claude Code sessions and preserves tool activity", () => {
    const path = fixture("claude.jsonl", [
      {
        uuid: "message-1",
        sessionId: "claude-123",
        type: "user",
        timestamp: "2026-07-14T10:00:00Z",
        cwd: "/work/billing",
        gitBranch: "feature/invoices",
        message: { role: "user", content: "Implement invoice matching" },
      },
      {
        uuid: "message-2",
        sessionId: "claude-123",
        type: "assistant",
        timestamp: "2026-07-14T10:01:00Z",
        cwd: "/work/billing",
        gitBranch: "feature/invoices",
        message: {
          role: "assistant",
          model: "claude-opus-4",
          content: [
            { type: "text", text: "I will inspect the schema." },
            { type: "tool_use", name: "Read", input: { file: "schema.sql" } },
          ],
        },
      },
    ]);

    const session = parseTranscript("claude-code", path);

    expect(session).toMatchObject({
      provider_session_id: "claude-123",
      repository: "billing",
      branch: "feature/invoices",
      agent_name: "claude-code",
      model: "claude-opus-4",
    });
    expect(session?.entries.map((entry) => entry.entry_type)).toEqual([
      "message",
      "message",
      "tool_call",
    ]);
    expect(session?.entries[2]?.content).toContain("schema.sql");
  });

  it("redacts common credentials before upload", () => {
    const path = fixture("codex-secrets.jsonl", [
      {
        timestamp: "2026-07-14T10:00:00Z",
        type: "session_meta",
        payload: { id: "codex-secret", cwd: "/work/private" },
      },
      {
        timestamp: "2026-07-14T10:01:00Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "api_key=super-secret-value" }],
        },
      },
    ]);

    const session = parseTranscript("codex", path);

    expect(session?.entries[0]?.content).toBe("api_key=[REDACTED]");
    expect(session?.raw_transcript).not.toContain("super-secret-value");
    expect(session?.prompts).toEqual(["api_key=[REDACTED]"]);
  });

  it("extracts embedded images from raw and compact transcripts", () => {
    const image = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("fixture"),
    ]).toString("base64");
    const path = fixture("claude-image.jsonl", [
      {
        uuid: "message-1",
        sessionId: "claude-image",
        type: "user",
        timestamp: "2026-07-14T10:00:00Z",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Inspect this screenshot" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: image },
            },
          ],
        },
      },
    ]);

    const session = parseTranscript("claude-code", path);

    expect(session?.assets).toHaveLength(1);
    expect(session?.assets?.[0]?.data_base64).toBe(image);
    expect(session?.raw_transcript).not.toContain(image);
    expect(session?.raw_transcript).toContain("asset_id");
    expect(session?.entries.at(-1)?.entry_type).toBe("asset");
    expect(session?.entries.at(-1)?.content).toContain("sha256:");
  });
});

function fixture(name: string, lines: unknown[]): string {
  const directory = temporaryDirectory();
  const path = join(directory, name);
  writeFileSync(
    path,
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
  return path;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "tilde-chat-slurper-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
