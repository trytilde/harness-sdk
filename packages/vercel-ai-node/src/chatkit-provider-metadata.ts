import type { JsonObject, JsonValue } from "@trytilde/harness-sdk";
import type { ChatKitRequestMessage } from "./chatkit-request";

export type GitHubChatKitMessageMetadata = {
  event: string | null;
  delivery_id: string;
  installation_id: number | null;
  repository_id: number | null;
  owner: string | null;
  repo: string | null;
  issue_number: number | null;
  pull_number: number | null;
  comment_id: number | null;
  comment_node_id: string | null;
  comment_url: string | null;
  html_url: string | null;
  thread_kind:
    | "issue"
    | "pull_request"
    | "pull_request_review_comment"
    | "pull_request_review"
    | null;
  message_identity: string;
};

export type SlackChatKitMessageMetadata = {
  team_id: string | null;
  channel_id: string;
  thread_ts: string | null;
  message_ts: string;
  event_ts: string | null;
  user: string | null;
};

export type ChatKitProviderMetadata =
  | {
      provider: "chatkit.channel.github";
      metadata: GitHubChatKitMessageMetadata;
    }
  | {
      provider: "chatkit.channel.slack";
      metadata: SlackChatKitMessageMetadata;
    };

export type ChatKitEndpointProviderContext = {
  github?: GitHubChatKitMessageMetadata;
  slack?: SlackChatKitMessageMetadata;
  $chatkit_meta_provider?: ChatKitProviderMetadata;
};

export function chatKitProviderContext(
  messages: ChatKitRequestMessage[],
): ChatKitEndpointProviderContext {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const metadata = messages[index]?.metadata;
    const provider = parseProviderMetadata(metadata);
    if (!provider) continue;
    if (provider.provider === "chatkit.channel.github") {
      return {
        github: provider.metadata,
        $chatkit_meta_provider: provider,
      };
    }
    return {
      slack: provider.metadata,
      $chatkit_meta_provider: provider,
    };
  }
  return {};
}

export function parseProviderMetadata(
  value: JsonValue | undefined,
): ChatKitProviderMetadata | null {
  if (!isRecord(value) || typeof value.provider !== "string") return null;
  if (value.provider === "chatkit.channel.github") {
    const metadata = parseGitHubMetadata(value.github);
    return metadata ? { provider: value.provider, metadata } : null;
  }
  if (value.provider === "chatkit.channel.slack") {
    const metadata = parseSlackMetadata(value.slack);
    return metadata ? { provider: value.provider, metadata } : null;
  }
  return null;
}

function parseGitHubMetadata(
  value: JsonValue | undefined,
): GitHubChatKitMessageMetadata | null {
  if (!isRecord(value)) return null;
  if (
    !nullableString(value.event) ||
    typeof value.delivery_id !== "string" ||
    !nullableNumber(value.installation_id) ||
    !nullableNumber(value.repository_id) ||
    !nullableString(value.owner) ||
    !nullableString(value.repo) ||
    !nullableNumber(value.issue_number) ||
    !nullableNumber(value.pull_number) ||
    !nullableNumber(value.comment_id) ||
    !nullableString(value.comment_node_id) ||
    !nullableString(value.comment_url) ||
    !nullableString(value.html_url) ||
    !githubThreadKind(value.thread_kind) ||
    typeof value.message_identity !== "string"
  ) {
    return null;
  }
  return value as GitHubChatKitMessageMetadata;
}

function parseSlackMetadata(
  value: JsonValue | undefined,
): SlackChatKitMessageMetadata | null {
  if (
    !isRecord(value) ||
    !nullableString(value.team_id) ||
    typeof value.channel_id !== "string" ||
    !nullableString(value.thread_ts) ||
    typeof value.message_ts !== "string" ||
    !nullableString(value.event_ts) ||
    !nullableString(value.user)
  ) {
    return null;
  }
  return value as SlackChatKitMessageMetadata;
}

function nullableString(value: JsonValue | undefined): boolean {
  return value === null || typeof value === "string";
}

function nullableNumber(value: JsonValue | undefined): boolean {
  return value === null || typeof value === "number";
}

function githubThreadKind(value: JsonValue | undefined): boolean {
  return (
    value === null ||
    value === "issue" ||
    value === "pull_request" ||
    value === "pull_request_review_comment" ||
    value === "pull_request_review"
  );
}

function isRecord(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
