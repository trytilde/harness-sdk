import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadDotenvFiles(cwd = process.cwd()): void {
  const originalKeys = new Set(Object.keys(process.env));
  const loaded: Record<string, string> = {};

  for (const filename of [".env", ".env.local"]) {
    const path = resolve(cwd, filename);
    if (!existsSync(path)) {
      continue;
    }
    Object.assign(loaded, parseDotenv(readFileSync(path, "utf8")));
  }

  for (const [key, value] of Object.entries(loaded)) {
    if (!originalKeys.has(key)) {
      process.env[key] = value;
    }
  }
}

export function parseDotenv(input: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const assignment = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equalsIndex = assignment.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }
    const key = assignment.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    values[key] = parseDotenvValue(assignment.slice(equalsIndex + 1).trim());
  }
  return values;
}

function parseDotenvValue(value: string): string {
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replaceAll("\\n", "\n")
      .replaceAll("\\r", "\r")
      .replaceAll("\\t", "\t")
      .replaceAll('\\"', '"')
      .replaceAll("\\\\", "\\");
  }
  const commentIndex = value.search(/\s#/);
  return (commentIndex === -1 ? value : value.slice(0, commentIndex)).trim();
}
