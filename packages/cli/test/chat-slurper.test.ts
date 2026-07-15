import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installProviderHooks,
  parseTranscript,
  removeProviderHooks,
} from "../src/chat-slurper";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("chat-slurper hook configuration", () => {
  it("installs exactly one Tilde command when configured repeatedly", () => {
    const home = temporaryDirectory();

    installProviderHooks("codex", home);
    installProviderHooks("codex", home);

    const hooksFile = join(home, ".codex", "hooks.json");
    const configured = JSON.parse(readFileSync(hooksFile, "utf8")) as {
      hooks: { Stop: Array<{ hooks: Array<{ command?: string }> }> };
    };
    const commands = configured.hooks.Stop.flatMap((matcher) => matcher.hooks)
      .map((hook) => hook.command)
      .filter((command) => command?.includes("tilde chat-slurper"));
    expect(commands).toEqual([
      "tilde chat-slurper capture-hook --provider codex --quiet",
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
    expect(session?.entries[1]?.content).toContain("schema.sql");
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
