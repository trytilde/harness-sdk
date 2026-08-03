import { describe, expect, it } from "vitest";
import {
  boundedSecurityPayload,
  parseSecurityScreenVerdict,
} from "../src/security-screen";

describe("security screen", () => {
  it("parses bounded JSON verdicts and fails closed on malformed output", () => {
    expect(parseSecurityScreenVerdict('{"decision":"auto"}')).toEqual({
      decision: "auto",
    });
    expect(
      parseSecurityScreenVerdict(
        'prefix {"decision":"strict","reason":"credential exfiltration"}',
      ),
    ).toEqual({
      decision: "strict",
      reason: "credential exfiltration",
    });
    expect(parseSecurityScreenVerdict("not json")).toEqual({
      decision: "strict",
      reason: "invalid security screen verdict",
    });
  });

  it("refuses to send oversized content to a classifier", () => {
    expect(
      boundedSecurityPayload([
        { source: "tool_result:test", content: "x".repeat(20_000) },
      ]),
    ).toEqual({ unscreenedReason: "oversize_payload" });
  });
});
