import type { UIMessage } from "ai";
import {
  type ChatKitConvertedMessage,
  type ChatKitContextClient,
  currentChatKitContext,
} from "./chatkit-context";

type Awaitable<T> = T | Promise<T>;

export type ChatKitMessageRole = UIMessage["role"];

export type ChatKitMessageBase = {
  id: string;
  role: ChatKitMessageRole;
  created_at?: string;
  updated_at?: string;
  metadata?: Record<string, unknown> | null;
  provider_metadata?: Record<string, unknown> | null;
  cached_agent_representation?: Record<string, unknown> | null;
};

export type ChatKitTextMessage = ChatKitMessageBase & {
  type: "text";
  text: string;
};

export type ChatKitUiTextPart = {
  type: "text";
  text?: string | null;
  provider_metadata?: Record<string, unknown> | null;
};

export type ChatKitUiReasoningPart = {
  type: "reasoning";
  text?: string | null;
  provider_metadata?: Record<string, unknown> | null;
};

export type ChatKitUiFilePart = {
  type: "file";
  media_type?: string;
  mediaType?: string;
  mimeType?: string;
  filename?: string | null;
  url: string;
  attachment_id?: string | null;
  size_bytes?: number | null;
  sha256?: string | null;
  provider_metadata?: Record<string, unknown> | null;
  providerMetadata?: Record<string, unknown> | null;
};

export type ChatKitUiPart =
  | ChatKitUiTextPart
  | ChatKitUiReasoningPart
  | ChatKitUiFilePart;

export type ChatKitUiMessage = ChatKitMessageBase & {
  type: "ui";
  parts: ChatKitUiPart[];
};

export type ChatKitMessage = ChatKitTextMessage | ChatKitUiMessage;

export type ConvertToAiSdkFileUploadHandler = (input: {
  message: ConvertToAiSdkMessageInput;
  part: ChatKitUiFilePart;
}) => Awaitable<UIMessage["parts"][number] | null>;

export type ConvertToAiSdkCacheHandler = (input: {
  message: ChatKitMessage;
  convertedMessage: UIMessage;
}) => Awaitable<ChatKitConvertedMessage | null | void>;

export type ConvertToAiSdkHydrateHandler = (input: {
  message: ChatKitMessage;
  cachedAgentRepresentation: Record<string, unknown>;
}) => Awaitable<UIMessage | null>;

export type ConvertToAiSdkMessageInput = ChatKitMessage | UIMessage;

export type ConvertToAiSdkMessageOptions = {
  message: ConvertToAiSdkMessageInput;
  chatkit?: ChatKitContextClient;
  onUnprocessedFileUpload?: ConvertToAiSdkFileUploadHandler;
  onCacheMessage?: ConvertToAiSdkCacheHandler;
  onHydrateMessage?: ConvertToAiSdkHydrateHandler;
};

export type ConvertToAiSdkMessagesOptions = Omit<
  ConvertToAiSdkMessageOptions,
  "message"
> & {
  messages: Iterable<ConvertToAiSdkMessageInput>;
};

type InternalConvertToAiSdkMessageOptions = ConvertToAiSdkMessageOptions & {
  deferCache?: boolean;
  cacheEntries?: ChatKitConvertedMessage[];
};

export function isChatKitMessage(value: unknown): value is ChatKitMessage {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string") return false;
  if (!isAiSdkRole(value.role)) return false;
  if (
    value.cached_agent_representation !== undefined &&
    value.cached_agent_representation !== null &&
    !isRecord(value.cached_agent_representation)
  ) {
    return false;
  }
  if (value.type === "text") return typeof value.text === "string";
  if (value.type === "ui") {
    return Array.isArray(value.parts) && value.parts.every(isChatKitUiPart);
  }
  return false;
}

/** Convert one ChatKit message into a Vercel AI SDK UIMessage. */
export async function convertToAiSdkMessage(
  options: ConvertToAiSdkMessageOptions,
): Promise<UIMessage> {
  return convertToAiSdkMessageInternal(options);
}

async function convertToAiSdkMessageInternal(
  options: InternalConvertToAiSdkMessageOptions,
): Promise<UIMessage> {
  const { message } = options;
  if (!isChatKitMessage(message)) {
    return convertUiMessageToAiSdkMessage(message, options);
  }
  const chatKitOptions = {
    ...options,
    message,
  } satisfies InternalConvertToAiSdkMessageOptions & { message: ChatKitMessage };
  const hydrated = await hydrateCachedMessage(chatKitOptions);
  if (hydrated) return hydrated;

  const converted =
    message.type === "text"
      ? ({
          id: message.id,
          role: message.role,
          parts: [{ type: "text", text: message.text }],
          metadata: aiSdkMetadata(message),
        } as UIMessage)
      : ({
          id: message.id,
          role: message.role,
          parts: await convertPartsToAiSdkParts(message, chatKitOptions),
          metadata: aiSdkMetadata(message),
        } as UIMessage);

  await cacheConvertedMessage(chatKitOptions, converted);
  return converted;
}

/** Convert ChatKit messages into Vercel AI SDK UIMessage objects. */
export async function convertToAiSdkMessages(
  options: ConvertToAiSdkMessagesOptions,
): Promise<UIMessage[]> {
  const converted: UIMessage[] = [];
  const cacheEntries: ChatKitConvertedMessage[] = [];
  for (const message of options.messages) {
    converted.push(
      await convertToAiSdkMessageInternal({
        ...options,
        message,
        deferCache: true,
        cacheEntries,
      }),
    );
  }
  if (cacheEntries.length > 0) {
    const chatkit = options.chatkit ?? currentChatKitContext();
    await chatkit?.cacheConvertedMessages({ messages: cacheEntries });
  }
  return converted;
}

async function hydrateCachedMessage(
  options: ConvertToAiSdkMessageOptions & { message: ChatKitMessage },
): Promise<UIMessage | null> {
  const cached = options.message.cached_agent_representation;
  if (!cached) return null;
  if (options.onHydrateMessage) {
    return options.onHydrateMessage({
      message: options.message,
      cachedAgentRepresentation: cached,
    });
  }
  return isUiMessage(cached) ? (cached as unknown as UIMessage) : null;
}

async function convertPartsToAiSdkParts(
  message: ChatKitUiMessage,
  options: ConvertToAiSdkMessageOptions & { message: ChatKitMessage },
): Promise<UIMessage["parts"]> {
  const parts: UIMessage["parts"] = [];
  for (const part of message.parts) {
    const converted = await convertPartToAiSdkPart(message, part, options);
    if (converted) parts.push(converted);
  }
  return parts;
}

async function convertPartToAiSdkPart(
  message: ChatKitMessage,
  part: ChatKitUiPart,
  options: ConvertToAiSdkMessageOptions & { message: ChatKitMessage },
): Promise<UIMessage["parts"][number] | null> {
  if (part.type === "text") {
    return { type: "text", text: part.text ?? "" } as UIMessage["parts"][number];
  }
  if (part.type === "reasoning") {
    return {
      type: "reasoning",
      text: part.text ?? "",
    } as UIMessage["parts"][number];
  }
  return options.onUnprocessedFileUpload
    ? options.onUnprocessedFileUpload({ message, part })
    : null;
}

async function convertUiMessageToAiSdkMessage(
  message: UIMessage,
  options: ConvertToAiSdkMessageOptions,
): Promise<UIMessage> {
  return {
    ...message,
    parts: (
      await Promise.all(
        message.parts.map((part) => convertUiPartToAiSdkPart(message, part, options)),
      )
    ).filter((part): part is UIMessage["parts"][number] => part !== null),
  } as UIMessage;
}

async function convertUiPartToAiSdkPart(
  message: UIMessage,
  part: UIMessage["parts"][number],
  options: ConvertToAiSdkMessageOptions,
): Promise<UIMessage["parts"][number] | null> {
  if (isRecord(part) && part.type === "file" && options.onUnprocessedFileUpload) {
    return options.onUnprocessedFileUpload({
      message,
      part: part as unknown as ChatKitUiFilePart,
    });
  }
  return part;
}

async function cacheConvertedMessage(
  options: InternalConvertToAiSdkMessageOptions & { message: ChatKitMessage },
  convertedMessage: UIMessage,
): Promise<void> {
  const cacheEntry = options.onCacheMessage
    ? await options.onCacheMessage({
        message: options.message,
        convertedMessage,
      })
    : defaultConvertedMessageCacheEntry(options.message, convertedMessage);
  if (!cacheEntry) return;
  if (options.deferCache) {
    options.cacheEntries?.push(cacheEntry);
    return;
  }
  const chatkit = options.chatkit ?? currentChatKitContext();
  if (!chatkit) return;
  await chatkit.cacheConvertedMessages({
    messages: [cacheEntry],
  });
}

function defaultConvertedMessageCacheEntry(
  message: ChatKitMessage,
  convertedMessage: UIMessage,
): ChatKitConvertedMessage {
  return {
    chatKitMessageId: message.id,
    message: convertedMessage as unknown as Record<string, unknown>,
  };
}

function aiSdkMetadata(message: ChatKitMessage): Record<string, unknown> {
  return {
    createdAt: message.created_at,
    updatedAt: message.updated_at,
    chatkit: {
      metadata: message.metadata ?? undefined,
      providerMetadata: message.provider_metadata ?? undefined,
    },
  };
}

function isChatKitUiPart(value: unknown): value is ChatKitUiPart {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "text" || value.type === "reasoning") {
    return value.text === undefined || value.text === null || typeof value.text === "string";
  }
  if (value.type === "file") return typeof value.url === "string";
  return false;
}

function isUiMessage(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === "string" &&
    isAiSdkRole(value.role) &&
    Array.isArray(value.parts)
  );
}

function isAiSdkRole(value: unknown): value is UIMessage["role"] {
  return value === "system" || value === "user" || value === "assistant";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
