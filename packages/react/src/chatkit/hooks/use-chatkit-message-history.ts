import type { JsonObject, JsonValue } from "@trytilde/harness-sdk";
import { useCallback, useEffect, useState } from "react";
import { useChatKit } from "./use-chatkit";

export type UseChatKitMessageHistoryOptions = {
  sessionId?: string;
  pageSize?: number;
  nextPageToken?: string;
  channelId?: string;
  participantInboxId?: string;
  externalUserId?: string;
  enabled?: boolean;
};

export type UseChatKitMessageHistoryResult<
  TMessage extends JsonValue = JsonObject,
> = {
  items: TMessage[];
  nextPageToken: string | undefined;
  isLoading: boolean;
  error: Error | null;
  reload(): Promise<void>;
};

export function useChatKitMessageHistory<
  TMessage extends JsonValue = JsonObject,
>(
  options: UseChatKitMessageHistoryOptions,
): UseChatKitMessageHistoryResult<TMessage> {
  const chatkit = useChatKit();
  const [items, setItems] = useState<TMessage[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const enabled = options.enabled ?? true;

  const reload = useCallback(async () => {
    if (!enabled || !options.sessionId) {
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const input: Parameters<typeof chatkit.listMessageHistory>[0] = {
        sessionId: options.sessionId,
      };
      if (options.pageSize !== undefined) {
        input.pageSize = options.pageSize;
      }
      if (options.nextPageToken !== undefined) {
        input.nextPageToken = options.nextPageToken;
      }
      if (options.channelId !== undefined) {
        input.channelId = options.channelId;
      }
      if (options.participantInboxId !== undefined) {
        input.participantInboxId = options.participantInboxId;
      }
      if (options.externalUserId !== undefined) {
        input.externalUserId = options.externalUserId;
      }
      const result = await chatkit.listMessageHistory<TMessage>(input);
      setItems(result.items);
      setNextPageToken(result.nextPageToken);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      setIsLoading(false);
    }
  }, [
    chatkit,
    enabled,
    options.channelId,
    options.externalUserId,
    options.nextPageToken,
    options.pageSize,
    options.participantInboxId,
    options.sessionId,
  ]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { items, nextPageToken, isLoading, error, reload };
}
