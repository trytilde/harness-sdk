import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryDirectory = mkdtempSync(
  join(tmpdir(), "tilde-harness-package-smoke-"),
);
const packages = [
  ["api-client", "packages/api-client"],
  ["harness-sdk", "packages/core"],
  ["harness-sdk-vercel-ai-node", "packages/vercel-ai-node"],
];

try {
  const tarballs = new Map();
  for (const [tarballName, packageDirectory] of packages) {
    const packageJson = JSON.parse(
      readFileSync(resolve(repositoryRoot, packageDirectory, "package.json")),
    );
    run("pnpm", [
      "--filter",
      packageJson.name,
      "pack",
      "--pack-destination",
      temporaryDirectory,
    ]);
    tarballs.set(
      packageJson.name,
      resolve(
        temporaryDirectory,
        `tilde-${tarballName}-${packageJson.version}.tgz`,
      ),
    );
  }

  const apiClientTarball = tarballs.get("@tilde/api-client");
  writeFileSync(
    resolve(temporaryDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "tilde-harness-package-smoke",
        private: true,
        type: "module",
        scripts: {
          build: "tsc",
          start: "node dist/index.js",
        },
        dependencies: {
          "@ai-sdk/mcp": "1.0.59",
          "@tilde/api-client": `file:${apiClientTarball}`,
          "@tilde/harness-sdk": `file:${tarballs.get("@tilde/harness-sdk")}`,
          "@tilde/harness-sdk-vercel-ai-node": `file:${tarballs.get(
            "@tilde/harness-sdk-vercel-ai-node",
          )}`,
          ai: "6.0.220",
        },
        devDependencies: {
          typescript: "5.9.3",
        },
        pnpm: {
          overrides: {
            "@tilde/api-client": `file:${apiClientTarball}`,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    resolve(temporaryDirectory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          outDir: "dist",
          strict: true,
          target: "ES2022",
        },
        include: ["index.ts"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    resolve(temporaryDirectory, "index.ts"),
    `import { whoami } from "@tilde/api-client/generated";
import {
  createClient,
  createTildeGrpcReverseProxy,
  reverseProxyPath,
} from "@tilde/harness-sdk";
import {
  parseChatKitRequestBody,
  type ChatKitRequestBody,
} from "@tilde/harness-sdk-vercel-ai-node";

const client = createClient({
  apiKey: "smoke-test",
  baseUrl: "https://api.trytilde.ai",
  orgId: "example",
  orgSubdomain: false,
  teamId: "team-id",
});
const proxy = createTildeGrpcReverseProxy({
  client,
  profileId: "profile-id",
});
const body: ChatKitRequestBody = parseChatKitRequestBody({
  messages: [],
  session_id: "session-id",
});

if (
  proxy.endpoint !== "https://api.trytilde.ai" ||
  typeof whoami !== "function" ||
  body.messages.length !== 0 ||
  reverseProxyPath({ profileId: "profile-id", teamId: "team-id" }) !==
    "/api/v1/team/team-id/reverse-proxy/profile-id"
) {
  throw new Error("Packed SDK runtime smoke test failed.");
}
console.log("Packed SDK consumer smoke test passed.");
`,
  );

  run("pnpm", ["install", "--frozen-lockfile=false"], temporaryDirectory);
  run("pnpm", ["build"], temporaryDirectory);
  run("pnpm", ["start"], temporaryDirectory);
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true });
}

function run(command, args, cwd = repositoryRoot) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}
