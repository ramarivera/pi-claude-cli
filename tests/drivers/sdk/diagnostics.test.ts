import { describe, expect, it } from "vitest";
import { sdkError } from "../../../src/drivers/sdk/diagnostics.js";

describe("SDK error sanitization", () => {
  it("keeps actionable text and subtype while removing selected and inherited secrets", () => {
    const error = Object.assign(
      new Error(
        "CLI executable missing; selected-offline-key inherited-offline-token Bearer abc123 token=another-secret https://user:password@example.invalid/path?key=secret#fragment",
      ),
      { code: "ENOENT" },
    );
    const result = sdkError(
      error,
      { mode: "api-key", apiKey: "selected-offline-key" },
      { SERVICE_TOKEN: "inherited-offline-token" },
      "fallback",
    );
    expect(result).toMatchObject({
      code: "transport",
      subtype: "ENOENT",
      message: expect.stringContaining("CLI executable missing"),
    });
    for (const secret of [
      "selected-offline-key",
      "inherited-offline-token",
      "abc123",
      "another-secret",
      "user:",
      "password@",
      "?key=",
      "#fragment",
    ])
      expect(result.message).not.toContain(secret);
    expect(result.message).toContain("https://example.invalid/path");
    const json = sdkError(
      {
        message: 'Runtime failure {"access_token": "hidden-json-value"}',
        code: "AUTH_FAILURE",
      },
      { mode: "claude-login" },
      {},
      "fallback",
    );
    expect(json.message).toContain("Runtime failure");
    expect(json.message).not.toContain("hidden-json-value");
    expect(json.subtype).toBe("AUTH_FAILURE");
  });

  it("bounds untrusted messages and doesn't expose secret error codes", () => {
    const error = Object.assign(new Error(`bad\n${"x".repeat(2000)}`), {
      code: "SECRET_ERROR_CODE",
    });
    const result = sdkError(
      error,
      { mode: "claude-login" },
      { SPECIAL_TOKEN: "SECRET_ERROR_CODE" },
      "fallback",
    );
    expect(result.message.length).toBeLessThanOrEqual(1000);
    expect(result.message).not.toContain("\n");
    expect(result.subtype).toBeUndefined();
    expect(
      sdkError(
        { error: "unknown" },
        { mode: "claude-login" },
        {},
        "SDK query failed",
      ).message,
    ).toBe("SDK query failed");
  });
});
