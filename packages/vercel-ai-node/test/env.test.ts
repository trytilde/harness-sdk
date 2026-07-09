import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDotenvFiles, parseDotenv } from "../src/env";

const touchedKeys = [
  "TILDE_BASE_URL",
  "TILDE_API_KEY",
  "TILDE_CHATKIT_WEBHOOK_SIGNING_KEY",
  "SHELL_ONLY_KEY",
];
const previousEnv = new Map<string, string | undefined>();

afterEach(() => {
  for (const key of touchedKeys) {
    const previous = previousEnv.get(key);
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
  previousEnv.clear();
});

describe("dotenv loading", () => {
  it("loads .env and lets .env.local override file values", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-sdk-env-"));
    rememberEnv();
    delete process.env.TILDE_BASE_URL;
    delete process.env.TILDE_API_KEY;
    delete process.env.TILDE_CHATKIT_WEBHOOK_SIGNING_KEY;
    try {
      writeFileSync(
        join(dir, ".env"),
        [
          "TILDE_BASE_URL=https://api.example.test",
          "TILDE_API_KEY=from-env",
          "TILDE_CHATKIT_WEBHOOK_SIGNING_KEY=from-env",
        ].join("\n"),
      );
      writeFileSync(
        join(dir, ".env.local"),
        [
          "TILDE_API_KEY=from-local",
          "TILDE_CHATKIT_WEBHOOK_SIGNING_KEY=from-local",
        ].join("\n"),
      );

      loadDotenvFiles(dir);

      expect(process.env.TILDE_BASE_URL).toBe("https://api.example.test");
      expect(process.env.TILDE_API_KEY).toBe("from-local");
      expect(process.env.TILDE_CHATKIT_WEBHOOK_SIGNING_KEY).toBe("from-local");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("does not override explicit shell environment variables", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-sdk-env-"));
    rememberEnv();
    process.env.TILDE_API_KEY = "from-shell";
    try {
      writeFileSync(join(dir, ".env"), "TILDE_API_KEY=from-env\n");
      writeFileSync(join(dir, ".env.local"), "TILDE_API_KEY=from-local\n");

      loadDotenvFiles(dir);

      expect(process.env.TILDE_API_KEY).toBe("from-shell");
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("parses quoted dotenv values", () => {
    expect(
      parseDotenv(
        [
          "PLAIN=value # comment",
          "SINGLE='quoted value'",
          'DOUBLE="line\\nvalue"',
          "export EXPORTED=value",
        ].join("\n"),
      ),
    ).toEqual({
      PLAIN: "value",
      SINGLE: "quoted value",
      DOUBLE: "line\nvalue",
      EXPORTED: "value",
    });
  });
});

function rememberEnv(): void {
  for (const key of touchedKeys) {
    previousEnv.set(key, process.env[key]);
  }
}
