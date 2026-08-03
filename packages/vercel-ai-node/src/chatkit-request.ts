import type { JsonObject, JsonValue } from "@trytilde/harness-sdk";

export type ChatKitRequestMessageRole = "system" | "user" | "assistant";

export type ChatKitRequestTextPart = {
  type: "text";
  text?: string;
};

export type ChatKitRequestReasoningPart = {
  type: "reasoning";
  text?: string;
};

export type ChatKitRequestFilePart = {
  type: "file";
  mediaType: string;
  filename?: string;
  url: string;
  providerMetadata?: JsonValue;
};

export type ChatKitRequestToolState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "approval-responded"
  | "output-available"
  | "output-error"
  | "output-denied";

export type ChatKitRequestApproval = {
  decision: "approved" | "rejected";
  reason?: string;
};

export type ChatKitRequestToolPart = {
  type: "dynamic-tool";
  toolCallId: string;
  toolName: string;
  state: ChatKitRequestToolState;
  input?: JsonValue;
  output?: JsonValue;
  errorText?: string;
  approval?: ChatKitRequestApproval;
};

export type ChatKitRequestSourceUrlPart = {
  type: "source-url";
  sourceId: string;
  url: string;
  title?: string;
};

export type ChatKitRequestSourceDocumentPart = {
  type: "source-document";
  sourceId: string;
  mediaType: string;
  title?: string;
  filename?: string;
};

export type ChatKitRequestStepStartPart = {
  type: "step-start";
};

export type ChatKitRequestDataPart = {
  type: "data";
  dataType: string;
  data: JsonValue;
};

export type ChatKitRequestMessagePart =
  | ChatKitRequestTextPart
  | ChatKitRequestReasoningPart
  | ChatKitRequestFilePart
  | ChatKitRequestToolPart
  | ChatKitRequestSourceUrlPart
  | ChatKitRequestSourceDocumentPart
  | ChatKitRequestStepStartPart
  | ChatKitRequestDataPart;

export type ChatKitRequestMessage = {
  id: string;
  role: ChatKitRequestMessageRole;
  parts: ChatKitRequestMessagePart[];
  metadata?: JsonValue;
};

export type ChatKitAgentSecurityPosture = "auto" | "strict" | "dangerous";

export type AgentWorkspaceKind = "personal" | "conversation" | "project";

export type AgentWorkspaceCredentialMode =
  | "fixed"
  | "invoking_actor"
  | "workspace_shared";

export type AgentWorkspaceSandboxBinding = {
  toolProviderInstanceId: string;
  sandboxId?: string | null;
  profileId?: string | null;
  scratch: boolean;
};

export type AgentWorkspaceInvocationPolicy = {
  securityPosture: ChatKitAgentSecurityPosture;
  deniedToolIds: string[];
  approvalRequiredToolIds: string[];
  deniedCommandPatterns: string[];
  maxWallClockSeconds: number;
};

/** Signed, server-resolved workspace facts for one invocation. */
export type AgentWorkspaceInvocationContext = {
  id: string;
  kind: AgentWorkspaceKind;
  subjectId: string;
  memoryBankIds: string[];
  credentialMode: AgentWorkspaceCredentialMode;
  sandbox?: AgentWorkspaceSandboxBinding | null;
  invocationPolicy: AgentWorkspaceInvocationPolicy;
  automationEnabled: boolean;
  appPublishingEnabled: boolean;
};

/** Server-owned runtime bindings injected into a verified ChatKit request. */
export type ChatKitAgentRuntimeConfiguration = {
  mcp_server_id: string;
  skill_registry_id?: string | null;
  system_prompt?: string | null;
  model?: string | null;
  max_steps: number;
  max_history_messages: number;
  security_posture: ChatKitAgentSecurityPosture;
};

export type ChatKitAgentInvocationActor = {
  external_user_id?: string | null;
  external_user_provider?: string | null;
  external_user_provider_account_id?: string | null;
  tilde_user_id?: string | null;
};

/** Identifies the configured agent instance and its durable Tilde resources. */
export type ChatKitAgentRuntimeContext = {
  agent_inbox_id: string;
  agent_inbox_instance_id: string;
  org_id: string;
  team_id: string;
  session_id: string;
  actor: ChatKitAgentInvocationActor;
  workspace?: AgentWorkspaceInvocationContext | null;
  configuration: ChatKitAgentRuntimeConfiguration;
};

export type ChatKitRequestBody = {
  chatId?: string | null;
  messages: ChatKitRequestMessage[];
  tildeContext?: ChatKitAgentRuntimeContext;
};

export class ChatKitRequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatKitRequestValidationError";
  }
}

export function parseChatKitRequestBody(value: JsonValue): ChatKitRequestBody {
  if (!isRecord(value)) {
    throw invalid("body", "must be an object");
  }
  if (
    value.chatId !== undefined &&
    value.chatId !== null &&
    typeof value.chatId !== "string"
  ) {
    throw invalid("body.chatId", "must be a string or null");
  }
  if (!Array.isArray(value.messages)) {
    throw invalid("body.messages", "must be an array");
  }

  const body: ChatKitRequestBody = {
    messages: value.messages.map((message, index) =>
      parseMessage(message, `body.messages[${index}]`),
    ),
  };
  if (value.chatId !== undefined) {
    body.chatId = value.chatId as string | null;
  }
  if (value.tildeContext !== undefined) {
    body.tildeContext = parseAgentRuntimeContext(
      value.tildeContext,
      "body.tildeContext",
    );
  }
  return body;
}

function parseAgentRuntimeContext(
  value: JsonValue,
  path: string,
): ChatKitAgentRuntimeContext {
  if (!isRecord(value)) throw invalid(path, "must be an object");
  const configuration = value.configuration;
  if (!isRecord(configuration)) {
    throw invalid(`${path}.configuration`, "must be an object");
  }
  const securityPosture = requiredString(
    configuration,
    "security_posture",
    `${path}.configuration`,
  );
  if (!isSecurityPosture(securityPosture)) {
    throw invalid(
      `${path}.configuration.security_posture`,
      'must be "auto", "strict", or "dangerous"',
    );
  }
  const maxSteps = requiredPositiveInteger(
    configuration,
    "max_steps",
    `${path}.configuration`,
  );
  const maxHistoryMessages = requiredPositiveInteger(
    configuration,
    "max_history_messages",
    `${path}.configuration`,
  );
  const parsed: ChatKitAgentRuntimeConfiguration = {
    mcp_server_id: requiredString(
      configuration,
      "mcp_server_id",
      `${path}.configuration`,
    ),
    max_steps: maxSteps,
    max_history_messages: maxHistoryMessages,
    security_posture: securityPosture,
  };
  for (const key of ["skill_registry_id", "system_prompt", "model"] as const) {
    const field = configuration[key];
    if (field !== undefined && field !== null && typeof field !== "string") {
      throw invalid(`${path}.configuration.${key}`, "must be a string or null");
    }
    if (field !== undefined) parsed[key] = field as string | null;
  }
  const actor = value.actor;
  if (!isRecord(actor)) throw invalid(`${path}.actor`, "must be an object");
  const parsedActor: ChatKitAgentInvocationActor = {};
  for (const key of [
    "external_user_id",
    "external_user_provider",
    "external_user_provider_account_id",
    "tilde_user_id",
  ] as const) {
    const field = actor[key];
    if (field !== undefined && field !== null && typeof field !== "string") {
      throw invalid(`${path}.actor.${key}`, "must be a string or null");
    }
    if (field !== undefined) parsedActor[key] = field as string | null;
  }
  const result: ChatKitAgentRuntimeContext = {
    agent_inbox_id: requiredString(value, "agent_inbox_id", path),
    agent_inbox_instance_id: requiredString(
      value,
      "agent_inbox_instance_id",
      path,
    ),
    org_id: requiredString(value, "org_id", path),
    team_id: requiredString(value, "team_id", path),
    session_id: requiredString(value, "session_id", path),
    actor: parsedActor,
    configuration: parsed,
  };
  if (value.workspace !== undefined && value.workspace !== null) {
    result.workspace = parseWorkspace(value.workspace, `${path}.workspace`);
  } else if (value.workspace === null) {
    result.workspace = null;
  }
  return result;
}

function parseWorkspace(
  value: JsonValue,
  path: string,
): AgentWorkspaceInvocationContext {
  if (!isRecord(value)) throw invalid(path, "must be an object");
  const kind = requiredString(value, "kind", path);
  if (kind !== "personal" && kind !== "conversation" && kind !== "project") {
    throw invalid(`${path}.kind`, "must be personal, conversation, or project");
  }
  const credentialMode = requiredString(value, "credentialMode", path);
  if (
    credentialMode !== "fixed" &&
    credentialMode !== "invoking_actor" &&
    credentialMode !== "workspace_shared"
  ) {
    throw invalid(
      `${path}.credentialMode`,
      "must be fixed, invoking_actor, or workspace_shared",
    );
  }
  const policyValue = value.invocationPolicy;
  if (!isRecord(policyValue)) {
    throw invalid(`${path}.invocationPolicy`, "must be an object");
  }
  const securityPosture = requiredString(
    policyValue,
    "securityPosture",
    `${path}.invocationPolicy`,
  );
  if (!isSecurityPosture(securityPosture)) {
    throw invalid(
      `${path}.invocationPolicy.securityPosture`,
      'must be "auto", "strict", or "dangerous"',
    );
  }
  const workspace: AgentWorkspaceInvocationContext = {
    id: requiredString(value, "id", path),
    kind,
    subjectId: requiredString(value, "subjectId", path),
    memoryBankIds: requiredStringArray(value, "memoryBankIds", path),
    credentialMode,
    invocationPolicy: {
      securityPosture,
      deniedToolIds: requiredStringArray(
        policyValue,
        "deniedToolIds",
        `${path}.invocationPolicy`,
      ),
      approvalRequiredToolIds: requiredStringArray(
        policyValue,
        "approvalRequiredToolIds",
        `${path}.invocationPolicy`,
      ),
      deniedCommandPatterns: requiredStringArray(
        policyValue,
        "deniedCommandPatterns",
        `${path}.invocationPolicy`,
      ),
      maxWallClockSeconds: requiredPositiveInteger(
        policyValue,
        "maxWallClockSeconds",
        `${path}.invocationPolicy`,
      ),
    },
    automationEnabled: requiredBoolean(value, "automationEnabled", path),
    appPublishingEnabled: requiredBoolean(value, "appPublishingEnabled", path),
  };
  if (value.sandbox !== undefined && value.sandbox !== null) {
    workspace.sandbox = parseWorkspaceSandbox(value.sandbox, `${path}.sandbox`);
  } else if (value.sandbox === null) {
    workspace.sandbox = null;
  }
  return workspace;
}

function parseWorkspaceSandbox(
  value: JsonValue,
  path: string,
): AgentWorkspaceSandboxBinding {
  if (!isRecord(value)) throw invalid(path, "must be an object");
  const sandbox: AgentWorkspaceSandboxBinding = {
    toolProviderInstanceId: requiredString(
      value,
      "toolProviderInstanceId",
      path,
    ),
    scratch: requiredBoolean(value, "scratch", path),
  };
  for (const key of ["sandboxId", "profileId"] as const) {
    const field = value[key];
    if (field !== undefined && field !== null && typeof field !== "string") {
      throw invalid(`${path}.${key}`, "must be a string or null");
    }
    if (field !== undefined) sandbox[key] = field as string | null;
  }
  return sandbox;
}

export function isChatKitRequestMessage(
  value: unknown,
): value is ChatKitRequestMessage {
  try {
    parseMessage(value as JsonValue, "message");
    return true;
  } catch {
    return false;
  }
}

function parseMessage(value: JsonValue, path: string): ChatKitRequestMessage {
  if (!isRecord(value)) throw invalid(path, "must be an object");
  if (typeof value.id !== "string") {
    throw invalid(`${path}.id`, "must be a string");
  }
  if (!isMessageRole(value.role)) {
    throw invalid(`${path}.role`, 'must be "system", "user", or "assistant"');
  }
  if (!Array.isArray(value.parts)) {
    throw invalid(`${path}.parts`, "must be an array");
  }
  const message: ChatKitRequestMessage = {
    id: value.id,
    role: value.role,
    parts: value.parts.map((part, index) =>
      parsePart(part, `${path}.parts[${index}]`),
    ),
  };
  if (value.metadata !== undefined) {
    message.metadata = value.metadata;
  }
  return message;
}

function parsePart(value: JsonValue, path: string): ChatKitRequestMessagePart {
  if (!isRecord(value)) throw invalid(path, "must be an object");
  switch (value.type) {
    case "text":
      optionalString(value, "text", path);
      return copyOptionalString({ type: "text" }, value, "text");
    case "reasoning":
      optionalString(value, "text", path);
      return copyOptionalString({ type: "reasoning" }, value, "text");
    case "file": {
      const part: ChatKitRequestFilePart = {
        type: "file",
        mediaType: requiredString(value, "mediaType", path),
        url: requiredString(value, "url", path),
      };
      copyOptionalStrings(part, value, path, ["filename"]);
      if (value.providerMetadata !== undefined) {
        part.providerMetadata = value.providerMetadata;
      }
      return part;
    }
    case "dynamic-tool": {
      const state = requiredString(value, "state", path);
      if (!isToolState(state)) {
        throw invalid(`${path}.state`, "is not a supported tool state");
      }
      const part: ChatKitRequestToolPart = {
        type: "dynamic-tool",
        toolCallId: requiredString(value, "toolCallId", path),
        toolName: requiredString(value, "toolName", path),
        state,
      };
      copyOptionalStrings(part, value, path, ["errorText"]);
      if (value.input !== undefined) part.input = value.input;
      if (value.output !== undefined) part.output = value.output;
      if (value.approval !== undefined) {
        part.approval = parseApproval(value.approval, `${path}.approval`);
      }
      return part;
    }
    case "source-url": {
      const part: ChatKitRequestSourceUrlPart = {
        type: "source-url",
        sourceId: requiredString(value, "sourceId", path),
        url: requiredString(value, "url", path),
      };
      copyOptionalStrings(part, value, path, ["title"]);
      return part;
    }
    case "source-document": {
      const part: ChatKitRequestSourceDocumentPart = {
        type: "source-document",
        sourceId: requiredString(value, "sourceId", path),
        mediaType: requiredString(value, "mediaType", path),
      };
      copyOptionalStrings(part, value, path, ["title", "filename"]);
      return part;
    }
    case "step-start":
      return { type: "step-start" };
    case "data":
      if (!Object.hasOwn(value, "data")) {
        throw invalid(`${path}.data`, "is required");
      }
      return {
        type: "data",
        dataType: requiredString(value, "dataType", path),
        data: value.data,
      };
    default:
      throw invalid(`${path}.type`, "is not a supported message part type");
  }
}

function parseApproval(value: JsonValue, path: string): ChatKitRequestApproval {
  if (!isRecord(value)) throw invalid(path, "must be an object");
  if (value.decision !== "approved" && value.decision !== "rejected") {
    throw invalid(`${path}.decision`, 'must be "approved" or "rejected"');
  }
  optionalString(value, "reason", path);
  return copyOptionalString({ decision: value.decision }, value, "reason");
}

function requiredString(value: JsonObject, key: string, path: string): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw invalid(`${path}.${key}`, "must be a string");
  }
  return field;
}

function requiredPositiveInteger(
  value: JsonObject,
  key: string,
  path: string,
): number {
  const field = value[key];
  if (!Number.isInteger(field) || (field as number) < 1) {
    throw invalid(`${path}.${key}`, "must be a positive integer");
  }
  return field as number;
}

function requiredBoolean(
  value: JsonObject,
  key: string,
  path: string,
): boolean {
  const field = value[key];
  if (typeof field !== "boolean") {
    throw invalid(`${path}.${key}`, "must be a boolean");
  }
  return field;
}

function requiredStringArray(
  value: JsonObject,
  key: string,
  path: string,
): string[] {
  const field = value[key];
  if (!Array.isArray(field) || field.some((item) => typeof item !== "string")) {
    throw invalid(`${path}.${key}`, "must be an array of strings");
  }
  return field as string[];
}

function isSecurityPosture(
  value: string,
): value is ChatKitAgentSecurityPosture {
  return value === "auto" || value === "strict" || value === "dangerous";
}

function optionalString(value: JsonObject, key: string, path: string): void {
  const field = value[key];
  if (field !== undefined && typeof field !== "string") {
    throw invalid(`${path}.${key}`, "must be a string when provided");
  }
}

function copyOptionalString<T extends object>(
  target: T,
  source: JsonObject,
  key: string,
): T & Record<string, string> {
  const value = source[key];
  if (typeof value === "string") {
    Object.assign(target, { [key]: value });
  }
  return target as T & Record<string, string>;
}

function copyOptionalStrings<T extends object>(
  target: T,
  source: JsonObject,
  path: string,
  keys: string[],
): void {
  for (const key of keys) {
    optionalString(source, key, path);
    copyOptionalString(target, source, key);
  }
}

function isMessageRole(value: JsonValue): value is ChatKitRequestMessageRole {
  return value === "system" || value === "user" || value === "assistant";
}

function isToolState(value: string): value is ChatKitRequestToolState {
  return (
    value === "input-streaming" ||
    value === "input-available" ||
    value === "approval-requested" ||
    value === "approval-responded" ||
    value === "output-available" ||
    value === "output-error" ||
    value === "output-denied"
  );
}

function isRecord(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(path: string, detail: string): ChatKitRequestValidationError {
  return new ChatKitRequestValidationError(
    `Invalid ChatKit request: ${path} ${detail}`,
  );
}
