#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { JsonObject, JsonValue } from "@tilde/harness-sdk";
import { Box, render, Text, useApp, useInput } from "ink";
import React from "react";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  deleteStoredAuth,
  ensureHarnessAuth,
  readSelectedOrgId,
  readSelectedTeamId,
  writeSelectedTeamId,
} from "./auth";
import { loadDotenvFiles } from "./env";
import type { RunLocalRuntimeTunnelCommandOptions } from "./tunnel";
import { runLocalRuntimeTunnelCommand } from "./tunnel";

type CommandName = "auth" | "state" | "tunnel" | "root";
type AuthAction = "login" | "logout" | "set-team" | "whoami";
type StateAction = "import" | "export";

type ParsedArgs = {
  commandName: CommandName;
  authAction?: AuthAction;
  stateAction?: StateAction;
  baseUrl?: string;
  orgId?: string;
  teamId?: string;
  cloudflaredPath?: string;
  filePath?: string;
  outputFilePath?: string;
  port?: number;
  autoApply?: boolean;
  command: string[];
};

type TeamChoice = {
  id: string;
  orgId: string;
  name: string;
  role?: string;
};

type WhoamiResponse = {
  email?: string | null;
  user?: {
    email?: string | null;
  };
  identity?: {
    email?: string | null;
  };
  teams?: Array<{
    team_id?: string;
    id?: string;
    org_id?: string;
    name?: string | null;
    role?: string;
  }>;
};

type StateItem = {
  id: string;
  type: string;
  name: string;
  action: string;
  status: "pending" | "running" | "success" | "warning" | "error";
  detail?: string;
};

type StatePlan = {
  items: StateItem[];
};

type ImportResult = {
  items: StateItem[];
  outputs: StateImportOutputs;
  events?: ImportEvent[];
  response?: JsonValue;
};

type StateImportOutputs = {
  resources: Record<string, JsonObject>;
};

type StateImportResponse = {
  import_id?: string;
  status?: string;
  plan?: JsonValue;
  outputs?: StateImportOutputs;
  errors?: string[];
};

type ImportEvent = {
  type?: string;
  event?: string;
  item_id?: string;
  id?: string;
  resource_id?: string;
  resource_type?: string;
  type_id?: string;
  name?: string;
  label?: string;
  action?: string;
  status?: string;
  message?: string;
  detail?: string;
  error?: string;
  outputs?: StateImportOutputs;
};

async function main() {
  loadDotenvFiles(invocationCwd());
  const args = parseArgs(process.argv.slice(2));
  if (args.commandName === "root") {
    await runRoot(args);
    return;
  }
  if (args.commandName === "auth") {
    await runAuthCommand(args);
    return;
  }
  if (args.commandName === "state") {
    await runStateCommand(args);
    return;
  }
  await runTunnelCommand(args);
}

async function runRoot(args: ParsedArgs): Promise<void> {
  const baseUrl = resolveBaseUrl(args);
  const tokens = await tryAccessTokenForCommand(args, baseUrl);
  if (!tokens) {
    await runAuthLogin(args);
    return;
  }
  await runAuthWhoami(args);
}

async function runAuthCommand(args: ParsedArgs): Promise<void> {
  if (!args.authAction) {
    throw new Error("Usage: tilde auth <login|logout|set-team|whoami>");
  }
  if (args.authAction === "login") {
    await runAuthLogin(args);
    return;
  }
  if (args.authAction === "logout") {
    await runAuthLogout(args);
    return;
  }
  if (args.authAction === "set-team") {
    await runAuthSetTeam(args);
    return;
  }
  await runAuthWhoami(args);
}

async function runAuthLogin(args: ParsedArgs): Promise<void> {
  const baseUrl = resolveBaseUrl(args);
  const method = await selectLoginMethod();
  await ensureHarnessAuth({
    baseUrl,
    teamId: args.teamId ?? readSelectedTeamId(baseUrl) ?? "unused",
    ...(args.orgId ? { orgId: args.orgId } : {}),
    ...(method === "device-code" ? { useDeviceCode: true } : {}),
  });
  console.log(`Signed in to ${baseUrl}`);
  await runAuthSetTeam(args);
}

async function runAuthLogout(args: ParsedArgs): Promise<void> {
  const baseUrl = resolveBaseUrl(args);
  deleteStoredAuth(baseUrl);
  console.log(`Signed out of ${baseUrl}`);
}

async function runAuthSetTeam(args: ParsedArgs): Promise<void> {
  const baseUrl = resolveBaseUrl(args);
  const { whoami } = await authenticatedWhoami(args, baseUrl);
  const teams = normalizeTeams(whoami);
  if (teams.length === 0) {
    throw new Error("No teams were returned by Tilde whoami.");
  }
  const selected = await renderSelect({
    title: "Select a Tilde team",
    items: teams.map((team) => ({
      label: team.name,
      value: team,
    })),
  });
  writeSelectedTeamId(baseUrl, selected.id, selected.orgId);
  console.log(`Selected Tilde team: ${selected.name} (${selected.id})`);
}

async function runAuthWhoami(args: ParsedArgs): Promise<void> {
  const baseUrl = resolveBaseUrl(args);
  const { whoami } = await authenticatedWhoami(args, baseUrl);
  const selectedTeamId = readSelectedTeamId(baseUrl);
  const selected = normalizeTeams(whoami).find(
    (team) => team.id === selectedTeamId,
  );
  console.log(`Email: ${whoamiEmail(whoami) ?? "unknown"}`);
  console.log(
    `Selected team: ${
      selected
        ? `${selected.name} (${selected.id})`
        : selectedTeamId
          ? selectedTeamId
          : "not set"
    }`,
  );
}

async function runStateCommand(args: ParsedArgs): Promise<void> {
  const baseUrl = resolveBaseUrl(args);
  if (!args.stateAction) {
    throw new Error("Usage: tilde state <import|export> [options] <file>");
  }
  if (!args.filePath) {
    throw new Error(stateUsage(args.stateAction));
  }
  const teamId = resolveRequiredTeamId(args, baseUrl);
  const orgId = resolveOptionalOrgId(args, baseUrl);
  const accessToken = await accessTokenForCommand(args, baseUrl);
  if (args.stateAction === "import") {
    const didImport = await importState({
      baseUrl,
      accessToken,
      ...(orgId ? { orgId } : {}),
      teamId,
      filePath: args.filePath,
      outputFilePath: requiredImportOutputFilePath(args),
      autoApply: args.autoApply ?? false,
    });
    if (didImport) {
      console.log("");
      console.log(
        `Complete any pending credentials in Tilde: ${credentialSetupUrl(baseUrl)}`,
      );
    }
    return;
  }
  await exportState({
    baseUrl,
    accessToken,
    ...(orgId ? { orgId } : {}),
    teamId,
    filePath: args.filePath,
  });
  console.log(`Exported Tilde state for team ${teamId} to ${args.filePath}`);
}

async function runTunnelCommand(args: ParsedArgs): Promise<void> {
  if (args.command.length === 0) {
    throw new Error("Usage: tilde tunnel [-p PORT] -- <command>");
  }
  const baseUrl = resolveBaseUrl(args);
  const options: RunLocalRuntimeTunnelCommandOptions = {
    baseUrl,
    teamId:
      args.teamId ??
      readSelectedTeamId(baseUrl) ??
      process.env.TILDE_TEAM_ID ??
      "daniels-workspace",
    command: args.command,
  };
  const bearerToken = env("TILDE_BEARER_TOKEN");
  if (bearerToken) {
    options.bearerToken = bearerToken;
  }
  const orgId = args.orgId ?? readSelectedOrgId(baseUrl) ?? env("TILDE_ORG_ID");
  if (orgId) {
    options.orgId = orgId;
  }
  if (args.cloudflaredPath) {
    options.cloudflaredPath = args.cloudflaredPath;
  }
  if (args.port !== undefined) {
    options.port = args.port;
  }

  const processHandle = await runLocalRuntimeTunnelCommand(options);
  console.log(
    `TILDE_LOCAL_RUNTIME_TUNNEL_ORIGIN=${processHandle.connector.tunnel_origin}`,
  );
  console.log(
    `TILDE_LOCAL_RUNTIME_TUNNEL_DOMAIN=${processHandle.connector.tunnel_domain}`,
  );
  console.log(`TUNNEL_PORT=${processHandle.localPort}`);

  const shutdown = () => processHandle.stop();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function parseArgs(args: string[]): ParsedArgs {
  if (args.length === 0) {
    return { commandName: "root", command: [] };
  }
  if (args[0] !== "auth" && args[0] !== "state" && args[0] !== "tunnel") {
    throw new Error("Usage: tilde <auth|state|tunnel> [options]");
  }
  const parsed: ParsedArgs = { commandName: args[0], command: [] };
  let positionalCount = 0;

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      throw new Error("Missing argument");
    }
    if (arg === "--") {
      parsed.command = args.slice(index + 1);
      return parsed;
    }
    if (arg === "-p" || arg === "--port") {
      parsed.port = parsePort(args[++index], arg);
      continue;
    }
    if (arg === "--base-url") {
      parsed.baseUrl = requiredValue(args[++index], arg);
      continue;
    }
    if (arg === "--team-id") {
      parsed.teamId = requiredValue(args[++index], arg);
      continue;
    }
    if (arg === "--org-id") {
      parsed.orgId = requiredValue(args[++index], arg);
      continue;
    }
    if (arg === "--cloudflared-path") {
      parsed.cloudflaredPath = requiredValue(args[++index], arg);
      continue;
    }
    if (arg === "--auto-apply") {
      parsed.autoApply = true;
      continue;
    }
    if (parsed.commandName === "auth" && !arg.startsWith("-")) {
      if (parsed.authAction !== undefined) {
        throw new Error("Usage: tilde auth <login|logout|set-team|whoami>");
      }
      if (
        arg !== "login" &&
        arg !== "logout" &&
        arg !== "set-team" &&
        arg !== "whoami"
      ) {
        throw new Error("Usage: tilde auth <login|logout|set-team|whoami>");
      }
      parsed.authAction = arg;
      continue;
    }
    if (parsed.commandName === "state" && !arg.startsWith("-")) {
      if (parsed.stateAction === undefined) {
        if (arg !== "import" && arg !== "export") {
          throw new Error(
            "Usage: tilde state <import|export> [options] <file>",
          );
        }
        parsed.stateAction = arg;
        continue;
      }
      positionalCount += 1;
      const maxPositionals = parsed.stateAction === "import" ? 2 : 1;
      if (positionalCount > maxPositionals) {
        throw new Error(stateUsage(parsed.stateAction));
      }
      if (positionalCount === 1) {
        parsed.filePath = arg;
      } else {
        parsed.outputFilePath = arg;
      }
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return parsed;
}

async function authenticatedWhoami(
  args: ParsedArgs,
  baseUrl: string,
): Promise<{ whoami: WhoamiResponse; accessToken: string }> {
  const accessToken = await accessTokenForCommand(args, baseUrl);
  const orgId = resolveOptionalOrgId(args, baseUrl);
  const whoami = (await apiRequest({
    baseUrl,
    accessToken,
    ...(orgId ? { orgId } : {}),
    path: "/api/v1/identity/auth/whoami",
  })) as WhoamiResponse;
  return { whoami, accessToken };
}

async function tryAccessTokenForCommand(
  args: ParsedArgs,
  baseUrl: string,
): Promise<string | undefined> {
  const explicit = env("TILDE_BEARER_TOKEN") ?? env("TILDE_API_KEY");
  if (explicit) {
    return explicit;
  }
  try {
    const orgId = resolveOptionalOrgId(args, baseUrl);
    const tokens = await ensureHarnessAuth({
      baseUrl,
      teamId: args.teamId ?? readSelectedTeamId(baseUrl) ?? "unused",
      ...(orgId ? { orgId } : {}),
      openBrowser: () => {
        throw new Error("not signed in");
      },
    });
    return tokens.accessToken;
  } catch {
    return undefined;
  }
}

async function accessTokenForCommand(
  args: ParsedArgs,
  baseUrl: string,
): Promise<string> {
  const explicit = env("TILDE_BEARER_TOKEN") ?? env("TILDE_API_KEY");
  if (explicit) {
    return explicit;
  }
  const orgId = resolveOptionalOrgId(args, baseUrl);
  const tokens = await ensureHarnessAuth({
    baseUrl,
    teamId: args.teamId ?? readSelectedTeamId(baseUrl) ?? "unused",
    ...(orgId ? { orgId } : {}),
  });
  return tokens.accessToken;
}

function resolveRequiredTeamId(args: ParsedArgs, baseUrl: string): string {
  if (args.teamId) {
    return args.teamId;
  }
  const selected = readSelectedTeamId(baseUrl);
  if (!selected) {
    throw new Error(
      "No Tilde team selected. Run `tilde auth set-team` or pass `--team-id`.",
    );
  }
  return selected;
}

function requiredImportOutputFilePath(args: ParsedArgs): string {
  if (!args.outputFilePath) {
    throw new Error(stateUsage("import"));
  }
  return args.outputFilePath;
}

function stateUsage(action?: StateAction): string {
  if (action === "import") {
    return "Usage: tilde state import [--team-id TEAM_ID] <state-file> <output-file>";
  }
  if (action === "export") {
    return "Usage: tilde state export [--team-id TEAM_ID] <output-file>";
  }
  return "Usage: tilde state <import|export> [options] <file>";
}

async function importState(input: {
  baseUrl: string;
  accessToken: string;
  orgId?: string;
  teamId: string;
  filePath: string;
  outputFilePath: string;
  autoApply: boolean;
}): Promise<boolean> {
  const filePath = resolveCliPath(input.filePath);
  if (!existsSync(filePath)) {
    throw new Error(`State file does not exist: ${input.filePath}`);
  }
  const body = readFileSync(filePath, "utf8");
  const fallbackPlan = planFromStateFile(body);
  const requestBody = stateJsonRequestBody(body);
  const validated = await validateState(input, requestBody, fallbackPlan);
  renderStaticStateTable(validated.items, "State import plan");

  if (!input.autoApply) {
    const apply = await renderConfirm("Apply this state import?");
    if (!apply) {
      console.log("Import cancelled.");
      return false;
    }
  }

  const result = await applyState(input, requestBody, validated.items);
  renderStaticStateTable(result.items, "State import result");
  writeImportOutput({
    baseUrl: input.baseUrl,
    teamId: input.teamId,
    stateFilePath: filePath,
    outputFilePath: input.outputFilePath,
    result,
  });
  console.log(`Saved import output to ${input.outputFilePath}`);
  return true;
}

function writeImportOutput(input: {
  baseUrl: string;
  teamId: string;
  stateFilePath: string;
  outputFilePath: string;
  result: ImportResult;
}): void {
  const outputPath = resolveCliPath(input.outputFilePath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    serializeImportOutput(input.outputFilePath, input.result.outputs),
    { mode: 0o600 },
  );
}

function serializeImportOutput(filePath: string, output: JsonValue): string {
  if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) {
    return stringifyYaml(output);
  }
  return `${JSON.stringify(output, null, 2)}\n`;
}

async function validateState(
  input: {
    baseUrl: string;
    accessToken: string;
    orgId?: string;
    teamId: string;
  },
  body: string,
  fallbackPlan: StatePlan,
): Promise<StatePlan> {
  const result = await apiRequest({
    baseUrl: input.baseUrl,
    accessToken: input.accessToken,
    ...(input.orgId ? { orgId: input.orgId } : {}),
    path: `/api/v1/team/${encodeURIComponent(input.teamId)}/state/plan`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body,
    tolerate404: true,
  });
  const responsePlan = statePlanFromResponse(result);
  return responsePlan && responsePlan.items.length > 0
    ? responsePlan
    : fallbackPlan;
}

async function applyState(
  input: {
    baseUrl: string;
    accessToken: string;
    orgId?: string;
    teamId: string;
  },
  body: string,
  initialItems: StateItem[],
): Promise<ImportResult> {
  const response = await rawApiRequest({
    baseUrl: input.baseUrl,
    accessToken: input.accessToken,
    ...(input.orgId ? { orgId: input.orgId } : {}),
    path: `/api/v1/team/${encodeURIComponent(input.teamId)}/state/import`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`state import failed: ${await response.text()}`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream") && response.body) {
    return await renderStateEventStream(response.body, initialItems);
  }
  const text = await response.text();
  const parsed = text ? safeJson(text) : undefined;
  const completed = await resolveStateImportResponse(input, parsed);
  return importResultFromResponse(completed, initialItems);
}

async function resolveStateImportResponse(
  input: {
    baseUrl: string;
    accessToken: string;
    orgId?: string;
    teamId: string;
  },
  response: JsonValue,
): Promise<JsonValue> {
  const importResponse = asStateImportResponse(response);
  if (
    !importResponse?.import_id ||
    !isPendingImportStatus(importResponse.status)
  ) {
    return response;
  }
  return await pollStateImport(input, importResponse.import_id);
}

async function pollStateImport(
  input: {
    baseUrl: string;
    accessToken: string;
    orgId?: string;
    teamId: string;
  },
  importId: string,
): Promise<JsonValue> {
  const deadline = Date.now() + 120_000;
  let lastResponse: JsonValue;
  while (Date.now() < deadline) {
    await sleep(1_000);
    const response = await apiRequest({
      baseUrl: input.baseUrl,
      accessToken: input.accessToken,
      ...(input.orgId ? { orgId: input.orgId } : {}),
      path: `/api/v1/team/${encodeURIComponent(input.teamId)}/state/import/${encodeURIComponent(importId)}`,
      headers: {
        Accept: "application/json",
      },
    });
    lastResponse = response;
    const importResponse = asStateImportResponse(response);
    if (!importResponse || !isPendingImportStatus(importResponse.status)) {
      return response;
    }
  }
  throw new Error(
    `state import ${importId} did not finish within 120 seconds. Last response: ${JSON.stringify(lastResponse)}`,
  );
}

function importResultFromResponse(
  response: JsonValue,
  initialItems: StateItem[],
): ImportResult {
  const importResponse = asStateImportResponse(response);
  if (isFailedImportStatus(importResponse?.status)) {
    const errors = importResponse?.errors?.length
      ? `: ${importResponse.errors.join("; ")}`
      : "";
    throw new Error(`state import failed${errors}`);
  }
  const outputs = outputsFromImportResponse(response);
  if (!outputs || Object.keys(outputs.resources).length === 0) {
    const importId = importResponse?.import_id
      ? ` ${importResponse.import_id}`
      : "";
    const status = importResponse?.status ? ` (${importResponse.status})` : "";
    throw new Error(
      `state import${importId}${status} completed without resource outputs; refusing to write an empty import output file`,
    );
  }
  return {
    items:
      statePlanFromResponse(importResponse?.plan)?.items ??
      statePlanFromResponse(response)?.items ??
      markAll(initialItems, "success"),
    outputs,
    ...(response !== undefined ? { response } : {}),
  };
}

function asStateImportResponse(
  response: JsonValue,
): StateImportResponse | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }
  return response as StateImportResponse;
}

function outputsFromImportResponse(
  response: JsonValue,
): StateImportOutputs | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }
  const record = response as JsonObject;
  const outputs = record.outputs;
  if (outputs && typeof outputs === "object") {
    const resources = (outputs as JsonObject).resources;
    if (isResourceOutputMap(resources)) {
      return { resources };
    }
  }
  const resources = record.resources;
  if (isResourceOutputMap(resources)) {
    return { resources };
  }
  return undefined;
}

function isResourceOutputMap(
  value: JsonValue,
): value is Record<string, JsonObject> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value as JsonObject);
  return entries.every(([key, resource]) => {
    if (!key.includes("/") || !resource || typeof resource !== "object") {
      return false;
    }
    const record = resource as JsonObject;
    return typeof record.action === "string" || typeof record.id === "string";
  });
}

function isPendingImportStatus(status?: string): boolean {
  const normalized = status?.toLowerCase();
  return (
    normalized === "queued" ||
    normalized === "pending" ||
    normalized === "running" ||
    normalized === "processing" ||
    normalized === "applying"
  );
}

function isFailedImportStatus(status?: string): boolean {
  const normalized = status?.toLowerCase();
  return normalized === "failed" || normalized === "error";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exportState(input: {
  baseUrl: string;
  accessToken: string;
  orgId?: string;
  teamId: string;
  filePath: string;
}): Promise<void> {
  const body = await apiRequest({
    baseUrl: input.baseUrl,
    accessToken: input.accessToken,
    ...(input.orgId ? { orgId: input.orgId } : {}),
    path: `/api/v1/team/${encodeURIComponent(input.teamId)}/state/export`,
    headers: {
      Accept: "application/yaml, text/yaml, text/plain",
    },
    rawText: true,
  });
  writeFileSync(resolveCliPath(input.filePath), `${body as string}\n`);
}

async function apiRequest(input: {
  baseUrl: string;
  accessToken: string;
  orgId?: string;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  rawText?: boolean;
  tolerate404?: boolean;
}): Promise<JsonValue> {
  const response = await rawApiRequest(input);
  if (input.tolerate404 && response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`${input.path} failed: ${await response.text()}`);
  }
  const text = await response.text();
  if (input.rawText) {
    return text;
  }
  if (!text) {
    return undefined;
  }
  return JSON.parse(text);
}

async function rawApiRequest(input: {
  baseUrl: string;
  accessToken: string;
  orgId?: string;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<Response> {
  const response = await fetch(new URL(input.path, input.baseUrl), {
    method: input.method ?? "GET",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      ...(input.orgId ? { "x-tilde-org-id": input.orgId } : {}),
      ...(input.headers ?? {}),
    },
    ...(input.body !== undefined ? { body: input.body } : {}),
  });
  return response;
}

function planFromStateFile(input: string): StatePlan {
  const parsed = parseYaml(input) as JsonValue;
  const items: StateItem[] = [];
  collectStateItems(parsed, items);
  return { items: items.length > 0 ? items : [] };
}

function stateJsonRequestBody(input: string): string {
  return JSON.stringify({ state: input, format: "yaml" });
}

function collectStateItems(
  value: JsonValue,
  items: StateItem[],
  path = "",
): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectStateItems(item, items, path ? `${path}.${index}` : String(index));
    });
    return;
  }
  const record = value as JsonObject;
  const resources = record.resources;
  if (resources && typeof resources === "object" && !Array.isArray(resources)) {
    for (const [resourceId, resource] of Object.entries(
      resources as JsonObject,
    )) {
      if (
        !resource ||
        typeof resource !== "object" ||
        Array.isArray(resource)
      ) {
        continue;
      }
      const resourceRecord = resource as JsonObject;
      items.push({
        id: resourceId,
        type: resourceTypeFromId(resourceId),
        name:
          stringField(resourceRecord, "displayName") ??
          stringField(resourceRecord, "name") ??
          resourceId,
        action: "import",
        status: normalizeStatus(stringField(resourceRecord, "status")),
      });
    }
    return;
  }
  if (isLikelyStateItem(record)) {
    items.push({
      id: stringField(record, "id") ?? path,
      type:
        stringField(record, "type") ??
        stringField(record, "kind") ??
        stringField(record, "resource_type") ??
        "resource",
      name:
        stringField(record, "name") ??
        stringField(record, "label") ??
        stringField(record, "displayName") ??
        stringField(record, "id") ??
        path,
      action: "import",
      status: "pending",
    });
    return;
  }
  for (const [key, child] of Object.entries(record)) {
    collectStateItems(child, items, path ? `${path}.${key}` : key);
  }
}

function isLikelyStateItem(record: JsonObject): boolean {
  return (
    typeof record.id === "string" ||
    typeof record.name === "string" ||
    typeof record.displayName === "string" ||
    typeof record.type === "string" ||
    typeof record.kind === "string"
  );
}

function resourceTypeFromId(resourceId: string): string {
  const parts = resourceId.split("/");
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : "resource";
}

function statePlanFromResponse(response: JsonValue): StatePlan | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }
  const record = response as JsonObject;
  const candidates = [
    record.items,
    record.resources,
    record.plan,
    record.changes,
    record.results,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return { items: candidate.map(normalizeStateItem) };
    }
    if (candidate && typeof candidate === "object") {
      const nested = statePlanFromResponse(candidate);
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
}

function normalizeStateItem(value: JsonValue, index: number): StateItem {
  const record =
    value && typeof value === "object" ? (value as JsonObject) : {};
  const detail =
    stringField(record, "message") ?? stringField(record, "detail");
  return {
    id:
      stringField(record, "id") ??
      stringField(record, "item_id") ??
      stringField(record, "resource_id") ??
      String(index + 1),
    type:
      stringField(record, "type") ??
      stringField(record, "resource_type") ??
      stringField(record, "kind") ??
      "resource",
    name:
      stringField(record, "name") ??
      stringField(record, "label") ??
      stringField(record, "displayName") ??
      stringField(record, "display_name") ??
      stringField(record, "id") ??
      String(index + 1),
    action: stringField(record, "action") ?? "import",
    status: normalizeStatus(stringField(record, "status")),
    ...(detail ? { detail } : {}),
  };
}

function applyImportEvent(items: StateItem[], event: ImportEvent): StateItem[] {
  const id = event.item_id ?? event.id ?? event.resource_id;
  const nextItem = normalizeStateItem(event, items.length);
  nextItem.status = normalizeStatus(event.status ?? event.event ?? event.type);
  const detail = event.message ?? event.detail ?? event.error;
  if (detail) {
    nextItem.detail = detail;
  }
  if (!id) {
    return [...items, nextItem];
  }
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) {
    return [...items, nextItem];
  }
  return items.map((item, itemIndex) =>
    itemIndex === index ? mergeStateItem(item, nextItem) : item,
  );
}

function mergeStateItem(item: StateItem, nextItem: StateItem): StateItem {
  return {
    ...item,
    status: nextItem.status,
    action: nextItem.action || item.action,
    ...((nextItem.detail ?? item.detail)
      ? { detail: nextItem.detail ?? item.detail }
      : {}),
  };
}

function markAll(items: StateItem[], status: StateItem["status"]): StateItem[] {
  return items.map((item) => ({ ...item, status }));
}

function normalizeStatus(value?: string): StateItem["status"] {
  const normalized = value?.toLowerCase();
  if (!normalized) {
    return "pending";
  }
  if (
    normalized.includes("success") ||
    normalized.includes("complete") ||
    normalized === "applied" ||
    normalized === "created" ||
    normalized === "updated"
  ) {
    return "success";
  }
  if (normalized.includes("error") || normalized.includes("fail")) {
    return "error";
  }
  if (normalized.includes("warn") || normalized.includes("skip")) {
    return "warning";
  }
  if (normalized.includes("run") || normalized.includes("apply")) {
    return "running";
  }
  return "pending";
}

async function renderStateEventStream(
  body: ReadableStream<Uint8Array>,
  initialItems: StateItem[],
): Promise<ImportResult> {
  const controller = { done: false, items: initialItems };
  const events: ImportEvent[] = [];
  const instance = render(React.createElement(StateTableLive, { controller }));
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split(/\n\n/);
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const data = sseData(chunk);
        if (!data) {
          continue;
        }
        const event = safeJson(data) as ImportEvent | undefined;
        if (event) {
          events.push(event);
          controller.items = applyImportEvent(controller.items, event);
          instance.rerender(
            React.createElement(StateTableLive, { controller }),
          );
        }
      }
    }
  } finally {
    controller.done = true;
    instance.rerender(React.createElement(StateTableLive, { controller }));
    instance.unmount();
  }
  const outputs = [...events]
    .reverse()
    .map((event) => outputsFromImportResponse(event))
    .find((eventOutputs) => eventOutputs !== undefined);
  if (!outputs || Object.keys(outputs.resources).length === 0) {
    throw new Error(
      "state import event stream completed without resource outputs; refusing to write an empty import output file",
    );
  }
  return {
    items: controller.items,
    outputs,
    events,
  };
}

function sseData(chunk: string): string | undefined {
  const lines = chunk.split(/\r?\n/);
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  return data || undefined;
}

function renderStaticStateTable(items: StateItem[], title: string): void {
  const instance = render(React.createElement(StateTable, { items, title }));
  instance.unmount();
}

function StateTable(props: { items: StateItem[]; title: string }) {
  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(Text, { bold: true }, props.title),
    React.createElement(
      Box,
      null,
      React.createElement(Text, { bold: true }, pad(" ", 2)),
      React.createElement(Text, { bold: true }, pad("Type", 22)),
      React.createElement(Text, { bold: true }, pad("Action", 12)),
      React.createElement(Text, { bold: true }, pad("Name", 34)),
      React.createElement(Text, { bold: true }, "Detail"),
    ),
    ...props.items.map((item) =>
      React.createElement(
        Box,
        { key: `${item.type}:${item.id}` },
        React.createElement(
          Text,
          { color: statusColor(item.status) },
          pad(statusIcon(item.status), 2),
        ),
        React.createElement(Text, null, pad(item.type, 22)),
        React.createElement(Text, null, pad(item.action, 12)),
        React.createElement(Text, null, pad(item.name, 34)),
        React.createElement(Text, { color: "gray" }, item.detail ?? ""),
      ),
    ),
  );
}

function StateTableLive(props: {
  controller: { done: boolean; items: StateItem[] };
}) {
  return React.createElement(StateTable, {
    title: props.controller.done ? "State import result" : "Applying state",
    items: props.controller.items,
  });
}

function statusIcon(status: StateItem["status"]): string {
  switch (status) {
    case "success":
      return "✓";
    case "warning":
      return "!";
    case "error":
      return "✕";
    case "running":
      return "…";
    default:
      return "•";
  }
}

function statusColor(status: StateItem["status"]): string {
  switch (status) {
    case "success":
      return "green";
    case "warning":
      return "yellow";
    case "error":
      return "red";
    case "running":
      return "cyan";
    default:
      return "gray";
  }
}

async function selectLoginMethod(): Promise<"browser" | "device-code"> {
  return renderSelect({
    title: "Sign in to Tilde",
    items: [
      { label: "Browser", value: "browser" as const },
      { label: "Device Code", value: "device-code" as const },
    ],
  });
}

async function renderSelect<T>(input: {
  title: string;
  items: Array<{ label: string; value: T }>;
}): Promise<T> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    if (input.items.length === 1) {
      const [item] = input.items;
      if (item) {
        return item.value;
      }
    }
    throw new Error(`${input.title} requires an interactive terminal.`);
  }
  return new Promise<T>((resolveSelection, rejectSelection) => {
    const instance = render(
      React.createElement(SelectPrompt<T>, {
        ...input,
        onSelect(value) {
          instance.unmount();
          resolveSelection(value);
        },
        onCancel() {
          instance.unmount();
          rejectSelection(new Error(`${input.title} cancelled.`));
        },
      }),
    );
  });
}

function SelectPrompt<T>(props: {
  title: string;
  items: Array<{ label: string; value: T }>;
  onSelect: (value: T) => void;
  onCancel: () => void;
}) {
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  useInput((_input, key) => {
    if (key.upArrow) {
      setSelectedIndex(
        (current) => (current + props.items.length - 1) % props.items.length,
      );
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((current) => (current + 1) % props.items.length);
      return;
    }
    if (key.return) {
      const selected = props.items[selectedIndex];
      if (selected) {
        props.onSelect(selected.value);
      }
      return;
    }
    if (key.ctrl && _input === "c") {
      props.onCancel();
    }
  });
  return React.createElement(
    Box,
    { flexDirection: "column" },
    React.createElement(Text, { bold: true }, props.title),
    ...props.items.map((item, index) =>
      React.createElement(
        Text,
        index === selectedIndex
          ? { key: item.label, color: "cyan" }
          : { key: item.label },
        `${index === selectedIndex ? "›" : " "} ${item.label}`,
      ),
    ),
    React.createElement(Text, { color: "gray" }, "Use arrows and Enter."),
  );
}

async function renderConfirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`${message} requires an interactive terminal.`);
  }
  return new Promise<boolean>((resolveConfirm) => {
    const instance = render(
      React.createElement(ConfirmPrompt, {
        message,
        onAnswer(value) {
          instance.unmount();
          resolveConfirm(value);
        },
      }),
    );
  });
}

function ConfirmPrompt(props: {
  message: string;
  onAnswer: (value: boolean) => void;
}) {
  const { exit } = useApp();
  useInput((input, key) => {
    if (input.toLowerCase() === "y") {
      props.onAnswer(true);
      exit();
    }
    if (input.toLowerCase() === "n" || key.escape) {
      props.onAnswer(false);
      exit();
    }
    if (key.ctrl && input === "c") {
      props.onAnswer(false);
      exit();
    }
  });
  return React.createElement(
    Text,
    null,
    `${props.message} `,
    React.createElement(Text, { color: "cyan" }, "[y/N]"),
  );
}

function normalizeTeams(whoami: WhoamiResponse): TeamChoice[] {
  return (whoami.teams ?? [])
    .map((team) => {
      const id = team.team_id ?? team.id;
      if (!id) {
        return undefined;
      }
      return {
        id,
        orgId: team.org_id ?? "",
        name: team.name?.trim() || id,
        ...(team.role ? { role: team.role } : {}),
      };
    })
    .filter((team): team is TeamChoice => Boolean(team))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function whoamiEmail(whoami: WhoamiResponse): string | undefined {
  return (
    whoami.email?.trim() ||
    whoami.user?.email?.trim() ||
    whoami.identity?.email?.trim() ||
    undefined
  );
}

function resolveBaseUrl(args: ParsedArgs): string {
  return args.baseUrl ?? env("TILDE_BASE_URL") ?? "https://api.trytilde.ai";
}

function resolveOptionalOrgId(
  args: ParsedArgs,
  baseUrl: string,
): string | undefined {
  return args.orgId ?? readSelectedOrgId(baseUrl) ?? env("TILDE_ORG_ID");
}

function resolveCliPath(path: string): string {
  return isAbsolute(path) ? path : resolve(invocationCwd(), path);
}

function invocationCwd(): string {
  return env("INIT_CWD") ?? process.cwd();
}

function parsePort(value: string | undefined, option: string): number {
  const raw = requiredValue(value, option);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${option} must be a TCP port between 1 and 65535`);
  }
  return port;
}

function requiredValue(value: string | undefined, option: string): string {
  if (!value) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : undefined;
}

function credentialSetupUrl(baseUrl: string): string {
  return new URL("/settings/team/pending-credentials", baseUrl).toString();
}

function stringField(record: JsonObject, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeJson(input: string): JsonValue {
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

function pad(value: string, width: number): string {
  return value.length >= width
    ? `${value.slice(0, Math.max(width - 1, 0))} `
    : value.padEnd(width, " ");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
