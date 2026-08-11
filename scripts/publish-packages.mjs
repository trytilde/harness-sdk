import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const packages = [
  "packages/api-client",
  "packages/core",
  "packages/cli",
  "packages/vercel-ai-node",
];
const dryRun = process.argv.includes("--dry-run");

for (const packageDirectory of packages) {
  const packageJsonPath = resolve(packageDirectory, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const packageVersion = `${packageJson.name}@${packageJson.version}`;

  const existing = run("npm", ["view", packageVersion, "version", "--json"], {
    allowFailure: true,
  });
  if (existing.status === 0) {
    console.log(`Skipping ${packageVersion}; it is already published.`);
    continue;
  }
  if (!existing.stderr.includes("E404")) {
    throw new Error(
      `Unable to check ${packageVersion} on npm:\n${existing.stderr}`,
    );
  }

  console.log(`Publishing ${packageVersion}...`);
  const publishArguments = [
    "--filter",
    packageJson.name,
    "publish",
    "--access",
    "public",
    "--no-git-checks",
  ];
  if (dryRun) publishArguments.push("--dry-run");
  run("pnpm", publishArguments);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
    stdio: options.allowFailure ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return {
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}
