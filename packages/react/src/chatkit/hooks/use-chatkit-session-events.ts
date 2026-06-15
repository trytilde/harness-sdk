import { useCallback, useEffect, useState } from "react";
import { useTildeClient } from "../../provider";

export type UseChatKitSessionEventsOptions = {
  sessionId?: string;
  pageSize?: number;
  nextPageToken?: string;
  includeChildSessions?: boolean;
  pollIntervalMs?: number;
  enabled?: boolean;
};

export type UseChatKitSessionEventsResult = {
  items: unknown[];
  nextPageToken: string | undefined;
  isLoading: boolean;
  error: Error | null;
  reload(): Promise<void>;
};

export function useChatKitSessionEvents(
  options: UseChatKitSessionEventsOptions,
): UseChatKitSessionEventsResult {
  const client = useTildeClient();
  const [items, setItems] = useState<unknown[]>([]);
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
      const result = await client.messages.eventHistory(input);
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
