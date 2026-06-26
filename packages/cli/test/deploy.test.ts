import { describe, expect, it } from "vitest";

describe("cli package", () => {
  it("exports a runnable entry module", async () => {
    const mod = await import("../src/index");

    expect(mod.main).toBeTypeOf("function");
  });
});
