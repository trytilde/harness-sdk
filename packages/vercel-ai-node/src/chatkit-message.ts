import type { JsonObject, JsonValue } from "@trytilde/harness-sdk";
import type { UIMessage } from "ai";
import {
  type ChatKitContextClient,
  type ChatKitConvertedMessage,
  currentChatKitContext,
} from "./chatkit-context";
import {
  type ChatKitRequestFilePart,
  type ChatKitRequestMessage,
  type ChatKitRequestMessagePart,
  isChatKitRequestMessage,
} from "./chatkit-request";

type Awaitable<T> = T | Promise<T>;

export type ChatKitMessageRole = UIMessage["role"];

export type ChatKitMessageBase = {
  id: string;
  role: ChatKitMessageRole;
  created_at?: string;
  updated_at?: string;
  metadata?: JsonObject | null;
  provider_metadata?: JsonObject | null;
  cached_agent_representation?: JsonObject | null;
};

export type ChatKitTextMessage = ChatKitMessageBase & {
  type: "text";
  text: string;
};

export type ChatKitUiTextPart = {
  type: "text";
  text?: string | null;
  provider_metadata?: JsonObject | null;
};

export type ChatKitUiReasoningPart = {
  type: "reasoning";
  text?: string | null;
  provider_metadata?: JsonObject | null;
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
  provider_metadata?: JsonObject | null;
  providerMetadata?: JsonObject | null;
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

export type ChatKitSignalMessage = ChatKitMessageBase & {
  type: "signal";
  role: "system";
  summary?: string | null;
  data?: JsonObject | null;
};

export type ChatKitHistoryMessage = ChatKitMessage | ChatKitSignalMessage;

export type FirecrawlMonitorPageStatus =
  | "same"
  | "new"
  | "changed"
  | "removed"
  | "error";

export type FirecrawlMonitorPageSignalType =
  `firecrawl.monitor.page.${FirecrawlMonitorPageStatus}`;
export type FirecrawlMonitorCheckCompletedSignalType =
  "firecrawl.monitor.check.completed";
export type FirecrawlSignalType =
  | FirecrawlMonitorPageSignalType
  | FirecrawlMonitorCheckCompletedSignalType;

export type FirecrawlSignalReference<
  TId extends string | null = string | null,
> = {
  id: TId;
};

export type FirecrawlMonitorPage = JsonObject & {
  monitorId?: string | null;
  checkId?: string | null;
  url: string;
  status: string;
  id?: string | null;
  scrapeId?: string | null;
  error?: string | null;
  isMeaningful?: boolean | null;
  judgment?: JsonValue;
  diff?: JsonValue;
};

export type FirecrawlMonitorPageSignalData = JsonObject & {
  event: "monitor.page";
  monitor: FirecrawlSignalReference;
  check: FirecrawlSignalReference;
  page: FirecrawlMonitorPage;
  metadata: JsonValue;
};

export type FirecrawlMonitorCheckResult = JsonObject & {
  monitorId?: string | null;
  checkId?: string | null;
  id?: string | null;
  status?: string | null;
  same?: number;
  new?: number;
  changed?: number;
  removed?: number;
  error?: number;
};

export type FirecrawlMonitorCheckCompletedSignalData = JsonObject & {
  event: "monitor.check.completed";
  monitor: FirecrawlSignalReference<string>;
  check: FirecrawlSignalReference<string>;
  result: FirecrawlMonitorCheckResult;
  metadata: JsonValue;
};

export type FirecrawlSignalMessage<
  TType extends FirecrawlSignalType = FirecrawlSignalType,
> = ChatKitSignalMessage & {
  metadata: JsonObject & { signal_type: TType };
  data: TType extends FirecrawlMonitorPageSignalType
    ? FirecrawlMonitorPageSignalData
    : FirecrawlMonitorCheckCompletedSignalData;
};

export type FirecrawlSignalByType = {
  [TType in FirecrawlSignalType]: FirecrawlSignalMessage<TType>;
};

export type GitHubIssueSignalAction =
  | "opened"
  | "reopened"
  | "closed"
  | "edited"
  | "labeled";

export type GitHubPullRequestSignalAction =
  | "opened"
  | "reopened"
  | "closed"
  | "merged"
  | "synchronize"
  | "synchronized"
  | "ready_for_review"
  | "converted_to_draft";

export type GitHubCiCheckSignalOutcome = "passed" | "failed";

export type GitHubIssueSignalType = `github.issue.${GitHubIssueSignalAction}`;
export type GitHubPullRequestSignalType =
  `github.pull_request.${GitHubPullRequestSignalAction}`;
export type GitHubCiCheckSignalType =
  `github.ci_check.${GitHubCiCheckSignalOutcome}`;
export type GitHubSignalType =
  | GitHubIssueSignalType
  | GitHubPullRequestSignalType
  | GitHubCiCheckSignalType;

export type GitHubWebhookRepository = JsonObject & {
  full_name: string;
  html_url?: string | null;
  name?: string | null;
};

export type GitHubWebhookIssue = JsonObject & {
  number: number;
  title: string;
  body?: string | null;
  html_url?: string | null;
};

export type GitHubWebhookPullRequest = JsonObject & {
  number: number;
  title: string;
  body?: string | null;
  html_url?: string | null;
  draft?: boolean | null;
  merged?: boolean | null;
};

export type GitHubWebhookCheck = JsonObject & {
  name?: string | null;
  status?: string | null;
  conclusion?: string | null;
  html_url?: string | null;
};

export type GitHubIssueWebhook<TAction extends GitHubIssueSignalAction> =
  JsonObject & {
    action: TAction;
    repository: GitHubWebhookRepository;
    issue: GitHubWebhookIssue;
  };

export type GitHubPullRequestWebhook<
  TAction extends GitHubPullRequestWebhookAction,
> = JsonObject & {
  action: TAction;
  repository: GitHubWebhookRepository;
  pull_request: GitHubWebhookPullRequest;
};

export type GitHubCiCheckWebhook = JsonObject & {
  action: "completed";
  repository: GitHubWebhookRepository;
  check_run?: GitHubWebhookCheck | null;
  check_suite?: GitHubWebhookCheck | null;
};

export type GitHubSignalMessage<
  TType extends GitHubSignalType = GitHubSignalType,
> = ChatKitSignalMessage & {
  metadata: JsonObject & { signal_type: TType };
  data: GitHubWebhookForSignalType<TType>;
};

export type GitHubSignalByType = {
  [TType in GitHubSignalType]: GitHubSignalMessage<TType>;
};

type GitHubPullRequestWebhookAction = Exclude<
  GitHubPullRequestSignalAction,
  "merged" | "synchronized"
>;

type GitHubWebhookForSignalType<TType extends GitHubSignalType> =
  TType extends `github.issue.${infer TAction extends GitHubIssueSignalAction}`
    ? GitHubIssueWebhook<TAction>
    : TType extends `github.pull_request.${infer TAction extends GitHubPullRequestSignalAction}`
      ? GitHubPullRequestWebhook<
          TAction extends "merged"
            ? "closed"
            : TAction extends "synchronized"
              ? "synchronize"
              : TAction
        >
      : TType extends GitHubCiCheckSignalType
        ? GitHubCiCheckWebhook
        : never;

export type SentryIssueSignalAction =
  | "created"
  | "assigned"
  | "resolved"
  | "unresolved"
  | "ignored";

export type SentryIssueSignalType = `sentry.issue.${SentryIssueSignalAction}`;

export type SentryWebhookProject = {
  id: unknown;
  slug: string;
  name?: string | null;
};

export type SentryWebhookOrganization = {
  id: unknown;
  slug: string;
  name?: string | null;
};

export type SentryWebhookIssue = JsonObject & {
  id: string;
  shortId?: string | null;
  title: string;
  culprit?: string | null;
  permalink?: string | null;
  status?: string | null;
  level?: string | null;
  platform?: string | null;
  project?: SentryWebhookProject | null;
};

export type SentryIssueWebhook<TAction extends SentryIssueSignalAction> = {
  action: TAction;
  installation?: { uuid: string } | null;
  actor?: { type: string; id: unknown; name: string } | null;
  data: {
    issue: SentryWebhookIssue;
    project?: SentryWebhookProject | null;
    organization?: SentryWebhookOrganization | null;
    event?: unknown;
  };
};

export type SentrySignalMessage<
  TType extends SentryIssueSignalType = SentryIssueSignalType,
> = ChatKitSignalMessage & {
  metadata: JsonObject & { signal_type: TType };
  data: SentryIssueWebhook<SentryActionForSignalType<TType>>;
};

export type SentrySignalByType = {
  [TType in SentryIssueSignalType]: SentrySignalMessage<TType>;
};

type SentryActionForSignalType<TType extends SentryIssueSignalType> =
  TType extends `sentry.issue.${infer TAction extends SentryIssueSignalAction}`
    ? TAction
    : never;

export type ConvertToAiSdkFileUploadHandler = (input: {
  message: ConvertToAiSdkMessageInput;
  part: ChatKitUiFilePart;
}) => Awaitable<UIMessage["parts"][number] | null>;

export type ConvertToAiSdkCacheHandler = (input: {
  message: ChatKitHistoryMessage;
  convertedMessage: UIMessage;
}) => Awaitable<ChatKitConvertedMessage | null | undefined>;

export type ConvertToAiSdkHydrateHandler = (input: {
  message: ChatKitHistoryMessage;
  cachedAgentRepresentation: JsonObject;
}) => Awaitable<UIMessage | null>;

export type ConvertToAiSdkSentryHandlers = {
  [TType in SentryIssueSignalType]?: (
    signal: SentrySignalByType[TType],
  ) => Awaitable<UIMessage | null>;
};

export type ConvertToAiSdkGitHubHandlers = {
  [TType in GitHubSignalType]?: (
    signal: GitHubSignalByType[TType],
  ) => Awaitable<UIMessage | null>;
};

export type ConvertToAiSdkFirecrawlHandlers = {
  [TType in FirecrawlSignalType]?: (
    signal: FirecrawlSignalByType[TType],
  ) => Awaitable<UIMessage | null>;
};

export type ConvertToAiSdkUnprocessedHandlers = {
  fileUpload?: ConvertToAiSdkFileUploadHandler;
  firecrawl?: ConvertToAiSdkFirecrawlHandlers;
  github?: ConvertToAiSdkGitHubHandlers;
  sentry?: ConvertToAiSdkSentryHandlers;
};

export type ConvertToAiSdkMessageInput =
  | ChatKitHistoryMessage
  | ChatKitRequestMessage
  | UIMessage;

export type ConvertToAiSdkMessageOptions = {
  message: ConvertToAiSdkMessageInput;
  chatkit?: ChatKitContextClient;
  onUnprocessed?: ConvertToAiSdkUnprocessedHandlers;
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

export function isChatKitSignalMessage(
  value: unknown,
): value is ChatKitSignalMessage {
  if (!isRecord(value)) return false;
  if (value.type !== "signal" || value.role !== "system") return false;
  if (typeof value.id !== "string") return false;
  if (
    value.cached_agent_representation !== undefined &&
    value.cached_agent_representation !== null &&
    !isRecord(value.cached_agent_representation)
  ) {
    return false;
  }
  if (
    value.summary !== undefined &&
    value.summary !== null &&
    typeof value.summary !== "string"
  ) {
    return false;
  }
  if (
    value.data !== undefined &&
    value.data !== null &&
    !isRecord(value.data)
  ) {
    return false;
  }
  return (
    value.metadata === undefined ||
    value.metadata === null ||
    isRecord(value.metadata)
  );
}

export function isChatKitHistoryMessage(
  value: unknown,
): value is ChatKitHistoryMessage {
  return isChatKitMessage(value) || isChatKitSignalMessage(value);
}

/** Convert one ChatKit message into a Vercel AI SDK UIMessage. */
export async function convertToAiSdkMessage(
  options: ConvertToAiSdkMessageOptions,
): Promise<UIMessage | null> {
  return convertToAiSdkMessageInternal(options);
}

async function convertToAiSdkMessageInternal(
  options: InternalConvertToAiSdkMessageOptions,
): Promise<UIMessage | null> {
  const { message } = options;
  if (isChatKitSignalMessage(message)) {
    const signalOptions = {
      ...options,
      message,
    } satisfies InternalConvertToAiSdkMessageOptions & {
      message: ChatKitSignalMessage;
    };
    const hydrated = await hydrateCachedMessage(signalOptions);
    if (hydrated) return hydrated;
    const converted = await convertSignalToAiSdkMessage(message, options);
    if (converted) await cacheConvertedMessage(signalOptions, converted);
    return converted;
  }
  if (!isChatKitMessage(message)) {
    if (isChatKitRequestMessage(message)) {
      return convertRequestMessageToAiSdkMessage(message, options);
    }
    return convertUiMessageToAiSdkMessage(message, options);
  }
  const chatKitOptions = {
    ...options,
    message,
  } satisfies InternalConvertToAiSdkMessageOptions & {
    message: ChatKitMessage;
  };
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

async function convertRequestMessageToAiSdkMessage(
  message: ChatKitRequestMessage,
  options: ConvertToAiSdkMessageOptions,
): Promise<UIMessage> {
  const parts = (
    await Promise.all(
      message.parts.map((part) =>
        convertRequestPartToAiSdkPart(message, part, options),
      ),
    )
  ).filter((part): part is UIMessage["parts"][number] => part !== null);
  return {
    id: message.id,
    role: message.role,
    parts,
  } as UIMessage;
}

async function convertRequestPartToAiSdkPart(
  message: ChatKitRequestMessage,
  part: ChatKitRequestMessagePart,
  options: ConvertToAiSdkMessageOptions,
): Promise<UIMessage["parts"][number] | null> {
  if (part.type === "text" || part.type === "reasoning") {
    return {
      type: part.type,
      text: part.text ?? "",
    } as UIMessage["parts"][number];
  }
  if (part.type === "file" && options.onUnprocessed?.fileUpload) {
    return options.onUnprocessed.fileUpload({
      message,
      part: requestFilePartToChatKitFilePart(part),
    });
  }
  if (part.type === "data") {
    return {
      type: `data-${part.dataType}`,
      data: part.data,
    } as UIMessage["parts"][number];
  }
  return part as UIMessage["parts"][number];
}

function requestFilePartToChatKitFilePart(
  part: ChatKitRequestFilePart,
): ChatKitUiFilePart {
  return {
    type: "file",
    mediaType: part.mediaType,
    url: part.url,
    ...(part.filename !== undefined ? { filename: part.filename } : {}),
    ...(isRecord(part.providerMetadata)
      ? { providerMetadata: part.providerMetadata }
      : {}),
  };
}

/** Convert ChatKit messages into Vercel AI SDK UIMessage objects. */
export async function convertToAiSdkMessages(
  options: ConvertToAiSdkMessagesOptions,
): Promise<UIMessage[]> {
  const converted: UIMessage[] = [];
  const cacheEntries: ChatKitConvertedMessage[] = [];
  for (const message of options.messages) {
    const convertedMessage = await convertToAiSdkMessageInternal({
      ...options,
      message,
      deferCache: true,
      cacheEntries,
    });
    if (convertedMessage) converted.push(convertedMessage);
  }
  if (cacheEntries.length > 0) {
    const chatkit = options.chatkit ?? currentChatKitContext();
    await chatkit?.cacheConvertedMessages({ messages: cacheEntries });
  }
  return converted;
}

async function hydrateCachedMessage(
  options: ConvertToAiSdkMessageOptions & { message: ChatKitHistoryMessage },
): Promise<UIMessage | null> {
  const cached = options.message.cached_agent_representation;
  if (!cached) return null;
  if (options.onHydrateMessage) {
    return options.onHydrateMessage({
      message: options.message,
      cachedAgentRepresentation: cached,
    });
  }
  return isUiMessage(cached) ? jsonObjectToUiMessage(cached) : null;
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
    return {
      type: "text",
      text: part.text ?? "",
    } as UIMessage["parts"][number];
  }
  if (part.type === "reasoning") {
    return {
      type: "reasoning",
      text: part.text ?? "",
    } as UIMessage["parts"][number];
  }
  return options.onUnprocessed?.fileUpload
    ? options.onUnprocessed.fileUpload({ message, part })
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
        message.parts.map((part) =>
          convertUiPartToAiSdkPart(message, part, options),
        ),
      )
    ).filter((part): part is UIMessage["parts"][number] => part !== null),
  } as UIMessage;
}

async function convertUiPartToAiSdkPart(
  message: UIMessage,
  part: UIMessage["parts"][number],
  options: ConvertToAiSdkMessageOptions,
): Promise<UIMessage["parts"][number] | null> {
  if (
    isRecord(part) &&
    part.type === "file" &&
    options.onUnprocessed?.fileUpload
  ) {
    return options.onUnprocessed.fileUpload({
      message,
      part: jsonObjectToChatKitUiFilePart(part),
    });
  }
  return part;
}

async function convertSignalToAiSdkMessage(
  message: ChatKitSignalMessage,
  options: ConvertToAiSdkMessageOptions,
): Promise<UIMessage | null> {
  const signalType = message.metadata?.signal_type;
  if (isFirecrawlSignalType(signalType)) {
    if (!isFirecrawlSignalMessage(message, signalType)) return null;
    const handler = options.onUnprocessed?.firecrawl?.[signalType] as
      | ((signal: FirecrawlSignalMessage) => Awaitable<UIMessage | null>)
      | undefined;
    return handler ? handler(message) : null;
  }
  if (isGitHubSignalType(signalType)) {
    if (!isGitHubSignalMessage(message, signalType)) return null;
    const handler = options.onUnprocessed?.github?.[signalType] as
      | ((signal: GitHubSignalMessage) => Awaitable<UIMessage | null>)
      | undefined;
    return handler ? handler(message) : null;
  }
  if (isSentryIssueSignalType(signalType)) {
    if (!isSentrySignalMessage(message, signalType)) return null;
    const handler = options.onUnprocessed?.sentry?.[signalType] as
      | ((signal: SentrySignalMessage) => Awaitable<UIMessage | null>)
      | undefined;
    return handler ? handler(message) : null;
  }
  return null;
}

async function cacheConvertedMessage(
  options: InternalConvertToAiSdkMessageOptions & {
    message: ChatKitHistoryMessage;
  },
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
  message: ChatKitHistoryMessage,
  convertedMessage: UIMessage,
): ChatKitConvertedMessage {
  return {
    chatKitMessageId: message.id,
    message: uiMessageToJsonObject(convertedMessage),
  };
}

function aiSdkMetadata(message: ChatKitMessage): JsonObject {
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
    return (
      value.text === undefined ||
      value.text === null ||
      typeof value.text === "string"
    );
  }
  if (value.type === "file") return typeof value.url === "string";
  return false;
}

function isUiMessage(value: JsonObject): boolean {
  return (
    typeof value.id === "string" &&
    isAiSdkRole(value.role) &&
    Array.isArray(value.parts)
  );
}

function isAiSdkRole(value: unknown): value is UIMessage["role"] {
  return value === "system" || value === "user" || value === "assistant";
}

function isFirecrawlSignalType(value: unknown): value is FirecrawlSignalType {
  return (
    value === "firecrawl.monitor.page.same" ||
    value === "firecrawl.monitor.page.new" ||
    value === "firecrawl.monitor.page.changed" ||
    value === "firecrawl.monitor.page.removed" ||
    value === "firecrawl.monitor.page.error" ||
    value === "firecrawl.monitor.check.completed"
  );
}

function isFirecrawlSignalMessage<TType extends FirecrawlSignalType>(
  message: ChatKitSignalMessage,
  signalType: TType,
): message is FirecrawlSignalMessage<TType> {
  const data = message.data;
  if (!data || !isRecord(data.monitor) || !isRecord(data.check)) return false;
  if (signalType.startsWith("firecrawl.monitor.page.")) {
    return (
      data.event === "monitor.page" &&
      isNullableString(data.monitor.id) &&
      isNullableString(data.check.id) &&
      isFirecrawlMonitorPage(data.page)
    );
  }
  return (
    data.event === "monitor.check.completed" &&
    typeof data.monitor.id === "string" &&
    typeof data.check.id === "string" &&
    isRecord(data.result)
  );
}

function isFirecrawlMonitorPage(value: unknown): value is FirecrawlMonitorPage {
  return (
    isRecord(value) &&
    typeof value.url === "string" &&
    typeof value.status === "string"
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isGitHubSignalType(value: unknown): value is GitHubSignalType {
  return (
    value === "github.issue.opened" ||
    value === "github.issue.reopened" ||
    value === "github.issue.closed" ||
    value === "github.issue.edited" ||
    value === "github.issue.labeled" ||
    value === "github.pull_request.opened" ||
    value === "github.pull_request.reopened" ||
    value === "github.pull_request.closed" ||
    value === "github.pull_request.merged" ||
    value === "github.pull_request.synchronize" ||
    value === "github.pull_request.synchronized" ||
    value === "github.pull_request.ready_for_review" ||
    value === "github.pull_request.converted_to_draft" ||
    value === "github.ci_check.passed" ||
    value === "github.ci_check.failed"
  );
}

function isGitHubSignalMessage<TType extends GitHubSignalType>(
  message: ChatKitSignalMessage,
  signalType: TType,
): message is GitHubSignalMessage<TType> {
  const data = message.data;
  if (!data || !isGitHubRepository(data.repository)) return false;
  if (signalType.startsWith("github.issue.")) {
    return (
      data.action === signalType.slice("github.issue.".length) &&
      isGitHubIssue(data.issue)
    );
  }
  if (signalType.startsWith("github.pull_request.")) {
    const signalAction = signalType.slice("github.pull_request.".length);
    const webhookAction =
      signalAction === "merged"
        ? "closed"
        : signalAction === "synchronized"
          ? "synchronize"
          : signalAction;
    return (
      data.action === webhookAction && isGitHubPullRequest(data.pull_request)
    );
  }
  return (
    data.action === "completed" &&
    (isGitHubCheck(data.check_run) || isGitHubCheck(data.check_suite))
  );
}

function isGitHubRepository(value: unknown): value is GitHubWebhookRepository {
  return isRecord(value) && typeof value.full_name === "string";
}

function isGitHubIssue(value: unknown): value is GitHubWebhookIssue {
  return (
    isRecord(value) &&
    typeof value.number === "number" &&
    typeof value.title === "string"
  );
}

function isGitHubPullRequest(
  value: unknown,
): value is GitHubWebhookPullRequest {
  return isGitHubIssue(value);
}

function isGitHubCheck(value: unknown): value is GitHubWebhookCheck {
  return isRecord(value);
}

function isSentryIssueSignalType(
  value: unknown,
): value is SentryIssueSignalType {
  return (
    value === "sentry.issue.created" ||
    value === "sentry.issue.assigned" ||
    value === "sentry.issue.resolved" ||
    value === "sentry.issue.unresolved" ||
    value === "sentry.issue.ignored"
  );
}

function isSentrySignalMessage<TType extends SentryIssueSignalType>(
  message: ChatKitSignalMessage,
  signalType: TType,
): message is SentrySignalMessage<TType> {
  const action = signalType.slice("sentry.issue.".length);
  const data = message.data;
  if (!data || data.action !== action || !isRecord(data.data)) return false;
  const issue = data.data.issue;
  return (
    isRecord(issue) &&
    typeof issue.id === "string" &&
    typeof issue.title === "string"
  );
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

function uiMessageToJsonObject(message: UIMessage): JsonObject {
  return message as unknown as JsonObject;
}

function jsonObjectToUiMessage(message: JsonObject): UIMessage {
  return message as unknown as UIMessage;
}

function jsonObjectToChatKitUiFilePart(part: JsonObject): ChatKitUiFilePart {
  return part as unknown as ChatKitUiFilePart;
}
