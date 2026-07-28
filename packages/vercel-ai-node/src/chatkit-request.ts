import type { JsonObject, JsonValue } from "@tilde/harness-sdk";

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
};

export type ChatKitRequestBody = {
  chatId?: string | null;
  messages: ChatKitRequestMessage[];
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
  return body;
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
  return {
    id: value.id,
    role: value.role,
    parts: value.parts.map((part, index) =>
      parsePart(part, `${path}.parts[${index}]`),
    ),
  };
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
