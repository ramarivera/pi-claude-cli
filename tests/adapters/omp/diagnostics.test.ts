import { describe, expect, it } from "vitest";
import type {
  ClaudeDriverEvent,
  JsonObject,
} from "../../../src/contracts/index.js";
import { projectOmpDiagnostic } from "../../../src/adapters/omp/diagnostics.js";

function diagnostic(
  subtype: string,
  data: JsonObject,
): Extract<ClaudeDriverEvent, { type: "observation" }> {
  return {
    type: "observation",
    family: "diagnostic",
    subtype,
    data,
    sequence: 7,
    attribution: {
      claudeSessionId: "session",
      turnId: "turn",
      messageId: "message",
      toolUseId: "call",
      parentToolUseId: null,
    },
  };
}
describe("native metadata-only diagnostics", () => {
  it("projects native admission metadata without rendering arbitrary lifecycle payloads", () => {
    const event = diagnostic("steering-admission", {
      commandId: "command",
      state: "started",
      content: "secret-never",
      raw: { password: "secret-never" },
    });
    expect(projectOmpDiagnostic(event)?.data).toEqual({
      commandId: "command",
      state: "started",
    });
    expect(JSON.stringify(projectOmpDiagnostic(event))).not.toContain(
      "secret-never",
    );
    expect(
      projectOmpDiagnostic(
        diagnostic("steering-admission", {
          commandId: "command",
          state: "secret-never",
        }),
      )?.data,
    ).toEqual({ commandId: "command" });
  });
  it.each([
    "core-message-start",
    "core-message-stop",
    "core-assistant-snapshot",
  ])(
    "projects %s message IDs and state without raw nested fields",
    (subtype) => {
      const event = diagnostic(subtype, {
        messageId: "message",
        previousActiveMessageId: "previous",
        activeMessageId: "message",
        ended: false,
        stopReasonPresent: true,
        blockCount: 1,
        blocks: [
          {
            index: 0,
            type: "tool_call",
            ended: true,
            toolCallId: "call",
            arguments: { secret: "never" },
            text: "never",
          },
        ],
        snapshotId: "snapshot",
        snapshotKnownMessage: true,
        snapshotFull: false,
        snapshotStopReasonPresent: true,
        runtimeBoundary: {
          roundDone: false,
          messageCount: 2,
          messages: [
            {
              messageId: "message",
              ended: false,
              blockCount: 1,
              toolCallIds: ["call"],
              content: "never",
            },
          ],
          unendedMessageIds: ["message"],
          proposalCount: 1,
          proposalIds: ["call"],
          unparkedProposalIds: [],
          parkedCount: 1,
          parkedIds: ["call"],
          deliveredCount: 1,
          deliveredIds: ["previous-call"],
          raw: { credentials: "never" },
        },
        raw: { text: "never", schemas: { properties: {} } },
      });
      Object.assign(event.attribution, {
        secret: "never",
        nested: { raw: "never" },
      });
      const projected = projectOmpDiagnostic(event);
      expect(projected?.data).toEqual({
        messageId: "message",
        previousActiveMessageId: "previous",
        activeMessageId: "message",
        ended: false,
        stopReasonPresent: true,
        blockCount: 1,
        blocks: [
          { index: 0, type: "tool_call", ended: true, toolCallId: "call" },
        ],
        ...(subtype === "core-assistant-snapshot"
          ? {
              snapshotId: "snapshot",
              snapshotKnownMessage: true,
              snapshotFull: false,
              snapshotStopReasonPresent: true,
            }
          : {}),
        runtimeBoundary: {
          roundDone: false,
          messageCount: 2,
          messages: [
            {
              messageId: "message",
              ended: false,
              blockCount: 1,
              toolCallIds: ["call"],
            },
          ],
          unendedMessageIds: ["message"],
          proposalCount: 1,
          proposalIds: ["call"],
          unparkedProposalIds: [],
          parkedCount: 1,
          parkedIds: ["call"],
          deliveredCount: 1,
          deliveredIds: ["previous-call"],
        },
      });
      expect(projected?.attribution).toEqual({
        claudeSessionId: "session",
        turnId: "turn",
        messageId: "message",
        toolUseId: "call",
        parentToolUseId: null,
      });
      expect(JSON.stringify(projected)).not.toContain("never");
      expect(event.data).toHaveProperty("raw");
    },
  );
  it("preserves SDK park identity and drops raw arguments, schemas and error data", () => {
    const projected = projectOmpDiagnostic(
      diagnostic("host-mcp-park", {
        toolUseId: "call",
        toolName: "edit",
        serverName: "host",
        arguments: { input: "never" },
        schema: { secret: "never" },
        error: "never",
        runtimeBoundary: { parkedCount: 1, parkedIds: ["call"] },
      }),
    );
    expect(projected?.data).toEqual({
      toolUseId: "call",
      toolName: "edit",
      serverName: "host",
      runtimeBoundary: { parkedCount: 1, parkedIds: ["call"] },
    });
  });
  it("drops unrecognized subtypes and families", () => {
    expect(
      projectOmpDiagnostic(diagnostic("raw-packet", { raw: "never" })),
    ).toBeUndefined();
    const event = diagnostic("host-mcp-park", {});
    if (event.type === "observation") event.family = "status";
    expect(projectOmpDiagnostic(event)).toBeUndefined();
  });
  it("bounds ID arrays and rejects invalid field types and unsafe ID strings", () => {
    const projected = projectOmpDiagnostic(
      diagnostic("core-message-start", {
        messageId: "x".repeat(129),
        previousActiveMessageId: null,
        activeMessageId: "bad\nID",
        ended: "true",
        blockCount: -1,
        runtimeBoundary: {
          proposalCount: "1",
          parkedIds: Array.from({ length: 40 }, (_, index) => `call-${index}`),
          messages: [
            {
              messageId: "valid",
              ended: true,
              blockCount: 1,
              toolCallIds: ["valid", { raw: "never" }],
            },
          ],
        },
      }),
    );
    expect(projected?.data).toEqual({
      previousActiveMessageId: null,
      runtimeBoundary: {
        parkedIds: Array.from({ length: 32 }, (_, index) => `call-${index}`),
        messages: [
          {
            messageId: "valid",
            ended: true,
            blockCount: 1,
            toolCallIds: ["valid"],
          },
        ],
      },
    });
  });
});
