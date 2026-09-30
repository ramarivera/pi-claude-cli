import { describe, expect, it } from "vitest";
import type {
  DriverSessionRequest,
  UnsequencedClaudeDriverEvent,
} from "../../src/contracts/index.js";
import { ControlChannel } from "../../src/drivers/cli/controls.js";
import recording from "../fixtures/claude/v1/recorded-initialize.json";

function makeChannel() {
  const sent: unknown[] = [];
  const events: UnsequencedClaudeDriverEvent[] = [];
  const failures: string[] = [];
  const request: DriverSessionRequest = {
    identity: {
      sessionId: "offline-recorded-control",
      branchId: "main",
      historyRevision: "1",
      driver: "cli",
      cwd: process.cwd(),
      configurationDigest: "offline",
      history: { messages: [], messageDigests: [], digest: "empty" },
    },
    resume: {
      mode: "fresh",
      restoration: "none",
      reason: "offline recorded control replay",
    },
    model: "claude-haiku-4-5-20251001",
    systemPrompt: "",
    tools: [],
    settings: {
      toolResultTimeoutMs: 1000,
      claudeTools: [],
      userMcpServers: [],
    },
    auth: { mode: "claude-login" },
  };
  return {
    sent,
    events,
    failures,
    channel: new ControlChannel(
      request,
      async (packet) => {
        sent.push(packet);
      },
      (event) => {
        events.push(event);
      },
      (message) => {
        failures.push(message);
      },
    ),
  };
}

describe("recorded Claude 2.1.285 initialization controls (offline replay, no inference)", () => {
  it("correlates the recorded nested request ID and preserves all public model capability fields", async () => {
    const { channel, sent, events, failures } = makeChannel();
    try {
      expect(recording.schemaVersion).toBe(1);
      expect(recording.fixtureVersion).toBe("1.0.0");
      expect(recording.provenance).toMatchObject({
        kind: "recorded",
        claudeCli: "2.1.285",
        capturedAt: "2026-09-30T11:55:22.048072+00:00",
      });
      expect(recording.provenance.sanitization).toBe(
        "Only public models retained; account and all other response fields removed",
      );
      expect(recording.argv).toContain("--no-session-persistence");
      const reply = channel.request(recording.request.request);
      expect(sent).toEqual([recording.request]);
      expect(recording.response.response.request_id).toBe(
        recording.request.request_id,
      );
      expect(channel.handle(recording.response)).toBe(true);
      const initialized = await reply;
      expect(initialized).toEqual(recording.response.response.response);
      expect(Object.keys(initialized)).toEqual(["models"]);
      expect(
        recording.response.response.response.models.map(
          ({ value, resolvedModel }) => [value, resolvedModel],
        ),
      ).toEqual([
        ["default", "claude-opus-5-5"],
        ["opus", "claude-opus-5-5"],
        ["claude-fable-5-1", "claude-fable-5-1"],
        ["sonnet", "claude-sonnet-5-5"],
        ["haiku", "claude-haiku-4-5-20251001"],
        ["claude-sonnet-5", "claude-sonnet-5"],
        ["claude-opus-5", "claude-opus-5"],
        ["claude-fable-5", "claude-fable-5"],
        ["claude-opus-4-8", "claude-opus-4-8"],
        ["claude-opus-4-7", "claude-opus-4-7"],
        ["claude-opus-4-6", "claude-opus-4-6"],
        ["claude-sonnet-4-6", "claude-sonnet-4-6"],
      ]);
      const haiku = recording.response.response.response.models.find(
        (model) => model.value === "haiku",
      );
      expect(haiku).toEqual({
        value: "haiku",
        resolvedModel: "claude-haiku-4-5-20251001",
        displayName: "Haiku 4.5",
        description: "Fastest for quick answers",
      });
      expect(haiku).not.toHaveProperty("supportsEffort");
      expect(haiku).not.toHaveProperty("supportedEffortLevels");
      expect(haiku).not.toHaveProperty("supportsAdaptiveThinking");
      for (const model of recording.response.response.response.models.filter(
        (model) => model.value !== "haiku",
      )) {
        expect(model.supportsEffort).toBe(true);
        expect(model.supportsAdaptiveThinking).toBe(true);
        expect(model.supportedEffortLevels).toEqual(
          ["claude-opus-4-6", "claude-sonnet-4-6"].includes(model.value)
            ? ["low", "medium", "high", "max"]
            : ["low", "medium", "high", "xhigh", "max"],
        );
      }
      expect(events).toEqual([]);
      expect(failures).toEqual([]);
      expect(channel.handle(recording.response)).toBe(true);
      expect(sent).toEqual([recording.request]);
    } finally {
      await channel.close();
    }
  });

  it("doesn't settle a pending initialize from an unrelated nested request ID", async () => {
    const { channel } = makeChannel();
    try {
      let settled = false;
      const reply = channel.request(recording.request.request).then((value) => {
        settled = true;
        return value;
      });
      expect(
        channel.handle({
          ...recording.response,
          response: {
            ...recording.response.response,
            request_id: "unrelated-control",
          },
        }),
      ).toBe(true);
      await Promise.resolve();
      expect(settled).toBe(false);
      channel.handle(recording.response);
      await expect(reply).resolves.toEqual(
        recording.response.response.response,
      );
    } finally {
      await channel.close();
    }
  });

  it("rejects obsolete top-level response IDs and leaves the valid request correlated", async () => {
    const { channel } = makeChannel();
    try {
      const reply = channel.request(recording.request.request);
      expect(() =>
        channel.handle({
          type: "control_response",
          request_id: recording.request.request_id,
          response: {
            subtype: "success",
            response: recording.response.response.response,
          },
        }),
      ).toThrow("Malformed nested control response ID");
      channel.handle(recording.response);
      await expect(reply).resolves.toEqual(
        recording.response.response.response,
      );
    } finally {
      await channel.close();
    }
  });
});
