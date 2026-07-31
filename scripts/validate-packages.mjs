import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const packages = [
  "packages/api-client",
  "packages/core",
  "packages/vercel-ai-node",
];

for (const packageDirectory of packages) {
  const packageJson = JSON.parse(
    readFileSync(resolve(packageDirectory, "package.json"), "utf8"),
  );
  const targets = new Set([
    packageJson.main,
    packageJson.types,
    ...exportTargets(packageJson.exports),
  ]);

  for (const dependencyGroup of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const [dependency, range] of Object.entries(
      packageJson[dependencyGroup] ?? {},
    )) {
      if (range.startsWith("workspace:")) {
        throw new Error(
          `${packageJson.name} has unpublished ${dependencyGroup} range ${dependency}@${range}`,
        );
      }
    }
  }

  for (const target of targets) {
    if (!target) continue;
    const relativeTarget = target.replace(/^\.\//, "");
    if (!existsSync(resolve(packageDirectory, relativeTarget))) {
      throw new Error(`${packageJson.name} is missing export ${target}`);
    }
  }

  const distFiles = walk(resolve(packageDirectory, "dist"));
  const testArtifact = distFiles.find((file) =>
    /(?:^|\/)(?:test|tests)(?:\/|$)/.test(file),
  );
  if (testArtifact) {
    throw new Error(
      `${packageJson.name} contains test artifact ${testArtifact}`,
    );
  }
  console.log(`Validated ${packageJson.name}@${packageJson.version}.`);
}

function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(exportTargets);
}

function walk(directory, root = directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory()
      ? walk(path, root)
      : [path.slice(root.length + 1).replaceAll("\\", "/")];
  });
}
