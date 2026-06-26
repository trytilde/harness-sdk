import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { readE2EEnv } from "./helpers/env";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

describe("hosted agent deploy e2e", () => {
  it(
    "deploys a hosted agent with the Tilde CLI, registers ChatKit, and invokes it",
    async () => {
      const env = readE2EEnv();
      const fixtureDir = path.join(repoRoot, "test/fixtures/hosted-agent");

      const args = [
        path.join(repoRoot, "packages/cli/dist/index.js"),
        "deploy",
        "--cwd",
        fixtureDir,
        "--project",
        "tilde-e2e-dev-hosted-agent",
        "--team",
        env.teamId,
        "--api-key",
        env.apiKey,
        "--configure-chatkit",
        "--invoke",
      ];
      if (env.orgId) {
        args.push("--org", env.orgId);
      }
      if (env.baseUrl) {
        args.push("--base-api-url", env.baseUrl);
      }

      const result = await execFileAsync("node", args, {
        cwd: repoRoot,
        env: {
          ...process.env,
          NODE_NO_WARNINGS: "1",
        },
        maxBuffer: 1024 * 1024 * 4,
        timeout: 1000 * 60 * 8,
      });

      expect(result.stdout).toContain("Deployed tilde-e2e-dev-hosted-agent");
      expect(result.stdout).toContain("Custom tool echo-tool:");
      expect(result.stdout).toContain("Registered custom tool provider");
      expect(result.stdout).toContain(
        "Registered ChatKit agent hosted-dummy-agent",
      );
      expect(result.stdout).toContain("Registered ChatKit Vercel UI channel");
      expect(result.stdout).toContain(
        "Invocation response: dummy response from dummy-agent",
      );
      expect(result.stdout).toContain(
        "Custom tool invocation response: dummy tool response from echo-tool: hello",
      );
    },
    1000 * 60 * 9,
  );
});
