import { describe, expect, it } from "vitest";
import {
  normalizeContext,
  Type,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  normalizeTranscript,
  payloadForHook,
  replacementRequest,
  toPiRequest,
} from "../../../src/adapters/pi/normalize.js";
import { assistant, configuration, model } from "./support.js";

const session = { sessionId: "host", branchId: "main", historyRevision: "0" };
const context = () =>
  normalizeContext({
    systemPrompt: "base",
    tools: [
      {
        name: "old",
        description: "inactive",
        parameters: Type.Object({ old: Type.String() }),
      },
    ],
    messages: [
      {
        role: "system",
        content: "later",
        sections: { one: "section" },
        toolsRemoved: [{ name: "old" }],
        toolsAdded: [
          {
            name: "native",
            description: "current",
            parameters: Type.Object({ newText: Type.String() }),
          },
        ],
        timestamp: 1,
      },
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "image", data: "base64", mimeType: "image/png" },
        ],
        timestamp: 2,
      },
    ],
  });
const request = (options: SimpleStreamOptions = {}) =>
  toPiRequest(
    context(),
    model,
    options,
    configuration,
    session,
    "/cwd",
    "round",
  );

describe("Pi transcript normalization", () => {
  it("replays current system sections and exact effective native schemas", () => {
    const result = request();
    expect(result.systemPrompt).toBe("base\n\nlater\n\nsection");
    expect(result.tools).toEqual([
      {
        name: "native",
        description: "current",
        owner: "host",
        inputSchema: {
          type: "object",
          required: ["newText"],
          properties: { newText: { type: "string" } },
        },
      },
    ]);
    expect(result.cwd).toBe("/cwd");
    expect(result.input).toEqual({
      kind: "prompt",
      content: [
        { type: "text", text: "hi" },
        { type: "image", data: "base64", mimeType: "image/png" },
      ],
    });
    expect(result.transcript.at(-1)).toEqual({
      role: "user",
      content: result.input.kind === "prompt" ? result.input.content : [],
    });
  });
  it("retains thinking signatures, canonical tool ids, errors and structured details", () => {
    const history = normalizeContext({
      messages: [
        {
          ...assistant(
            [
              {
                type: "thinking",
                thinking: "hidden",
                thinkingSignature: "signed",
                redacted: true,
              },
              {
                type: "toolCall",
                id: "toolu_123",
                name: "native",
                arguments: { newText: "yes" },
              },
            ],
            "error",
          ),
          errorMessage: "failed",
        },
        {
          role: "toolResult",
          toolCallId: "toolu_123",
          toolName: "native",
          content: [{ type: "image", data: "img", mimeType: "image/png" }],
          details: {
            structuredContent: { value: 7 },
            _meta: { source: "native" },
            other: "retained",
          },
          isError: true,
          timestamp: 3,
        },
      ],
    });
    expect(normalizeTranscript(history)).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "hidden",
            signature: "signed",
            redacted: true,
          },
          {
            type: "tool_call",
            id: "toolu_123",
            name: "native",
            arguments: { newText: "yes" },
          },
        ],
        stopReason: "error",
        errorMessage: "failed",
      },
      {
        role: "tool_result",
        toolCallId: "toolu_123",
        toolName: "native",
        content: [{ type: "image", data: "img", mimeType: "image/png" }],
        details: {
          structuredContent: { value: 7 },
          _meta: { source: "native" },
          other: "retained",
        },
        structuredContent: { value: 7 },
        _meta: { source: "native" },
        isError: true,
      },
    ]);
  });
  it("delivers every tool result by id even when steering splits the results", () => {
    const history = normalizeContext({
      messages: [
        assistant(
          [
            { type: "toolCall", id: "a", name: "native", arguments: {} },
            { type: "toolCall", id: "b", name: "native", arguments: {} },
          ],
          "toolUse",
        ),
        {
          role: "toolResult",
          toolCallId: "b",
          toolName: "native",
          content: [{ type: "text", text: "B" }],
          isError: false,
          timestamp: 2,
        },
        { role: "user", content: "steering", timestamp: 3 },
        {
          role: "toolResult",
          toolCallId: "a",
          toolName: "native",
          content: [{ type: "text", text: "A" }],
          isError: false,
          timestamp: 4,
        },
      ],
    });
    const result = toPiRequest(
      history,
      model,
      {},
      configuration,
      session,
      "/cwd",
      "r",
    );
    expect(result.input.kind).toBe("tool-results");
    if (result.input.kind === "tool-results") {
      expect(result.input.results.map((item) => item.toolCallId)).toEqual([
        "b",
        "a",
      ]);
      expect(result.input.steering).toEqual([
        { type: "text", text: "steering" },
      ]);
    }
  });
  it("passes supported reasoning and rejects unsupported Haiku effort", () => {
    expect(() => request({ reasoning: "minimal" })).toThrow(
      "reasoning minimal isn't supported",
    );
    expect(request({ reasoning: "low" }).settings.effort).toBe("low");
    expect(request({ reasoning: "high" }).settings.effort).toBe("high");
    expect(() =>
      toPiRequest(
        context(),
        { ...model, reasoning: false },
        { reasoning: "high" },
        configuration,
        session,
        "/cwd",
        "r",
      ),
    ).toThrow("doesn't support reasoning");
    expect(
      toPiRequest(
        context(),
        { ...model, reasoning: false },
        {},
        configuration,
        session,
        "/cwd",
        "r",
      ).settings.effort,
    ).toBeUndefined();
  });
  it.each([
    "fetch",
    "maxTokens",
    "temperature",
    "toolChoice",
    "thinkingBudgets",
    "deferred",
    "headers",
  ])("reports unsupported setting %s explicitly", (key) => {
    expect(() => request({ [key]: "unsupported" })).toThrow(`option ${key}`);
  });
  it("allows valid payload replacement without leaking auth or adding host tools", () => {
    const original = {
      ...request(),
      auth: { mode: "api-key" as const, apiKey: "secret" },
    };
    const payload = payloadForHook(original);
    expect(JSON.stringify(payload)).not.toContain("secret");
    const changed = replacementRequest(
      { ...payload, systemPrompt: "replacement" },
      original,
    );
    expect(changed.systemPrompt).toBe("replacement");
    expect(changed.auth).toEqual(original.auth);
    expect(() =>
      replacementRequest(
        { ...payload, auth: { mode: "claude-login" } },
        original,
      ),
    ).toThrow("cannot replace auth");
    expect(() =>
      replacementRequest(
        {
          ...payload,
          tools: [...payload.tools, { ...payload.tools[0], name: "inactive" }],
        },
        original,
      ),
    ).toThrow("effective inventory");
    expect(() => replacementRequest({ bad: true }, original)).toThrow();
  });
});
