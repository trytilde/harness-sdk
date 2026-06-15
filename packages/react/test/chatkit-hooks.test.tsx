// @vitest-environment happy-dom
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  TildeProvider,
  useChatKit,
  useChatKitMessageHistory,
  useChatKitSessionEvents,
  useTildeClient,
} from "../src";
import type { UseChatKitMessageHistoryResult } from "../src/chatkit/hooks";

describe("TildeProvider", () => {
  it("provides the configured core client", () => {
    let endpoint = "";

    function Probe() {
      const client = useTildeClient();
      const chatkit = useChatKit();
      endpoint = chatkit.vercelUiEndpoint({
        sessionId: "session/1",
        inboxId: "inbox 1",
        instanceId: "instance:1",
      });
      expect(client.chatkit).toBe(chatkit);
      return null;
    }

    render(
      <TildeProvider
        config={{
          baseUrl: "https://api.example.test",
          teamId: "team 123",
        }}
      >
        <Probe />
      </TildeProvider>,
    );

    expect(endpoint).toBe(
      "https://api.example.test/api/v1/team/team%20123/inbox/session/session%2F1/inbox/inbox%201/instance/instance%3A1/ai/ui",
    );
  });
});

describe("ChatKit hooks", () => {
  it("loads message history through the core ChatKit client", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(
        "https://api.example.test/api/v1/team/team_123/chatkit/sessions/session_1/messages?page_size=10",
      );
      return Response.json({
        items: [{ id: "msg_1" }],
        next_page_token: "next",
      });
    });
    let latest: UseChatKitMessageHistoryResult | undefined;

    function Probe() {
      latest = useChatKitMessageHistory({
        sessionId: "session_1",
        pageSize: 10,
      });
      return null;
    }

    render(
      <TildeProvider
        config={{
          baseUrl: "https://api.example.test",
          teamId: "team_123",
          fetch: fetchMock as typeof fetch,
        }}
      >
        <Probe />
      </TildeProvider>,
    );

    await waitFor(() => {
      expect(latest?.items).toEqual([{ id: "msg_1" }]);
    });
    expect(latest?.nextPageToken).toBe("next");
    expect(latest?.error).toBeNull();
  });

  it("loads session events through the core messages client", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(
        "https://api.example.test/api/v1/team/team_123/inbox/session/session_1/event-history?page_size=5&include_child_sessions=true",
      );
      return Response.json({
        items: [{ type: "message.created" }],
      });
    });
    let items: unknown[] = [];

    function Probe() {
      items = useChatKitSessionEvents({
        sessionId: "session_1",
        pageSize: 5,
        includeChildSessions: true,
      }).items;
      return null;
    }

    render(
      <TildeProvider
        config={{
          baseUrl: "https://api.example.test",
          teamId: "team_123",
          fetch: fetchMock as typeof fetch,
        }}
      >
        <Probe />
      </TildeProvider>,
    );

    await waitFor(() => {
      expect(items).toEqual([{ type: "message.created" }]);
    });
  });
});
