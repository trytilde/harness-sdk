// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TildeProvider, useChatKitVercelUiEndpoint } from "../src";

describe("useChatKitVercelUiEndpoint", () => {
  it("constructs Vercel UI endpoints from the Tilde React provider", () => {
    let endpoint = "";

    function Probe() {
      endpoint = useChatKitVercelUiEndpoint({
        sessionId: "session/1",
        inboxId: "inbox 1",
        instanceId: "instance:1",
        stream: true,
      });
      return null;
    }

    render(
      <TildeProvider
        config={{
          baseUrl: "https://api.example.test",
          teamId: "team 123",
          apiKey: "test-key",
        }}
      >
        <Probe />
      </TildeProvider>,
    );

    expect(endpoint).toBe(
      "https://api.example.test/api/v1/team/team%20123/inbox/session/session%2F1/inbox/inbox%201/instance/instance%3A1/ai/ui/stream",
    );
  });
});
