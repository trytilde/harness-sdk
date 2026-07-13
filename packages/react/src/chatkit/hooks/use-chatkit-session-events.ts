import { useCallback, useEffect, useState } from "react";
import type { JsonObject, JsonValue } from "@tilde/harness-sdk";
import { useTildeClient } from "../../provider";

export type UseChatKitSessionEventsOptions = {
  sessionId?: string;
  pageSize?: number;
  nextPageToken?: string;
  includeChildSessions?: boolean;
  pollIntervalMs?: number;
  enabled?: boolean;
};

export type UseChatKitSessionEventsResult<TEvent extends JsonValue = JsonObject> = {
  items: TEvent[];
  nextPageToken: string | undefined;
  isLoading: boolean;
  error: Error | null;
  reload(): Promise<void>;
};

export function useChatKitSessionEvents<TEvent extends JsonValue = JsonObject>(
  options: UseChatKitSessionEventsOptions,
): UseChatKitSessionEventsResult<TEvent> {
  const client = useTildeClient();
  const [items, setItems] = useState<TEvent[]>([]);
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
      const input: Parameters<typeof client.messages.eventHistory>[0] = {
        sessionId: options.sessionId,
      };
      if (options.pageSize !== undefined) {
        input.pageSize = options.pageSize;
      }
      if (options.nextPageToken !== undefined) {
        input.nextPageToken = options.nextPageToken;
      }
      if (options.includeChildSessions !== undefined) {
        input.includeChildSessions = options.includeChildSessions;
      }
      const result = await client.messages.eventHistory<TEvent>(input);
      setItems(result.items);
      setNextPageToken(result.nextPageToken);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error(String(caught)));
    } finally {
      setIsLoading(false);
    }
  }, [
    client,
    enabled,
    options.includeChildSessions,
    options.nextPageToken,
    options.pageSize,
    options.sessionId,
  ]);

  useEffect(() => {
    void reload();
    if (!enabled || !options.sessionId || !options.pollIntervalMs) {
      return;
    }
    const interval = setInterval(() => {
      void reload();
    }, options.pollIntervalMs);
    return () => clearInterval(interval);
  }, [enabled, options.pollIntervalMs, options.sessionId, reload]);

  return { items, nextPageToken, isLoading, error, reload };
}
