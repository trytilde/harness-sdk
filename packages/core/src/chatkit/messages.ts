import type { NormalizedConfig } from "../config";
import { requestJson } from "../internal/fetch-client";
import { pathWithParams, teamPath } from "../internal/paths";

const MESSAGE_PATH =
  "/api/v1/team/{team_id}/inbox/session/{session_id}/message";
const EVENT_HISTORY_PATH =
  "/api/v1/team/{team_id}/inbox/session/{session_id}/event-history";

type Paginated<T> = {
  items: T[];
  next_page_token?: string | null;
};

export class MessagesClient {
  readonly #config: NormalizedConfig;

  constructor(config: NormalizedConfig) {
    this.#config = config;
  }

  async list(input: {
    sessionId: string;
    pageSize?: number;
    nextPageToken?: string;
  }): Promise<{ items: unknown[]; nextPageToken?: string }> {
    const raw = await requestJson<Paginated<unknown>>(this.#config, {
      path: pathWithParams(teamPath(this.#config, MESSAGE_PATH), {
        session_id: input.sessionId,
      }),
      query: {
        page_size: input.pageSize ?? 100,
        next_page_token: input.nextPageToken,
      },
    });
    const result: { items: unknown[]; nextPageToken?: string } = {
      items: raw.items,
    };
    if (raw.next_page_token) {
      result.nextPageToken = raw.next_page_token;
    }
    return result;
  }

  async eventHistory(input: {
    sessionId: string;
    pageSize?: number;
    nextPageToken?: string;
    includeChildSessions?: boolean;
  }): Promise<{ items: unknown[]; nextPageToken?: string }> {
    const raw = await requestJson<Paginated<unknown>>(this.#config, {
      path: pathWithParams(teamPath(this.#config, EVENT_HISTORY_PATH), {
        session_id: input.sessionId,
      }),
      query: {
        page_size: input.pageSize ?? 100,
        next_page_token: input.nextPageToken,
        include_child_sessions: input.includeChildSessions,
      },
    });
    const result: { items: unknown[]; nextPageToken?: string } = {
      items: raw.items,
    };
    if (raw.next_page_token) {
      result.nextPageToken = raw.next_page_token;
    }
    return result;
  }
}
