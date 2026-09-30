import { describe, expect, it } from "vitest";
import type {
  Context,
  Model,
  Tool,
  SimpleStreamOptions,
} from "@oh-my-pi/pi-ai";
import {
  payloadForHook,
  normalizeTools,
  normalizeTranscript,
  replacePayload,
  toRequest,
} from "../../../src/adapters/omp/request.js";
import { readRuntimeConfiguration } from "../../../entrypoints/config.js";

const configuration = readRuntimeConfiguration({});
const model = { id: "claude-haiku-4-5", reasoning: false } as Model;
const session = { sessionId: "host", branchId: "root", historyRevision: "0" };
const context: Context = {
  systemPrompt: ["one", "two"],
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
};
function request(options: SimpleStreamOptions = {}) {
  return toRequest(model, context, options, configuration, session, "/project");
}

describe("native OMP request normalization", () => {
  it.each([
    [
      "hashline",
      {
        type: "object",
        properties: {
          input: { type: "string", description: "LINE:HASH edits" },
        },
        required: ["input"],
      },
    ],
    [
      "apply-patch",
      {
        type: "object",
        properties: {
          input: { type: "string", description: "*** Begin Patch" },
        },
        required: ["input"],
      },
    ],
    [
      "replacement",
      {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
      },
    ],
  ])(
    "preserves the selected %s edit schema and grammar",
    (_format, parameters) => {
      const customFormat = {
        syntax: "lark" as const,
        definition: "start: /[\\s\\S]+/",
      };
      const [tool] = normalizeTools([
        {
          name: "edit",
          description: "Native edit",
          parameters,
          customFormat,
          customWireName: "apply_patch",
          examples: [{ call: { input: "patch" } }],
        } as unknown as Tool,
      ]);
      expect(tool.inputSchema).toEqual(parameters);
      expect(tool._meta).toMatchObject({
        omp: {
          customFormat,
          customWireName: "apply_patch",
          examples: [{ call: { input: "patch" } }],
        },
      });
      expect(tool.owner).toBe("host");
    },
  );
  it("keeps glob, semantic find and bash seconds separate without inventory conversion", () => {
    const definitions = [
      {
        name: "glob",
        description: "files",
        parameters: {
          type: "object",
          properties: { pattern: { type: "string" } },
        },
      },
      {
        name: "find",
        description: "semantic",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            grep_keywords: { type: "array" },
          },
        },
      },
      {
        name: "bash",
        description: "shell",
        parameters: {
          type: "object",
          properties: { timeout: { type: "number", description: "seconds" } },
        },
      },
    ] as unknown as Tool[];
    expect(
      normalizeTools(definitions).map(({ name, inputSchema }) => ({
        name,
        inputSchema,
      })),
    ).toEqual(
      definitions.map(({ name, parameters }) => ({
        name,
        inputSchema: parameters,
      })),
    );
    expect(() =>
      normalizeTools([
        {
          name: "edit",
          description: "",
          parameters: () => ({}),
        } as unknown as Tool,
      ]),
    ).toThrow("callable inventory");
  });
  it("preserves full assistant history including thinking signatures and terminal state", () => {
    const history: Context = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm", thinkingSignature: "signed" },
            {
              type: "toolCall",
              id: "call",
              name: "find",
              arguments: { query: "word" },
            },
          ],
          stopReason: "error",
          errorMessage: "failed",
          timestamp: 0,
        } as Context["messages"][number],
        {
          role: "toolResult",
          toolCallId: "call",
          toolName: "find",
          content: [
            { type: "text", text: "bad" },
            { type: "image", data: "image", mimeType: "image/png" },
          ],
          isError: true,
          details: { code: "missing", nested: [1] },
          timestamp: 0,
        },
      ],
    };
    expect(normalizeTranscript(history)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm", signature: "signed" },
          {
            type: "tool_call",
            id: "call",
            name: "find",
            arguments: { query: "word" },
          },
        ],
        stopReason: "error",
        errorMessage: "failed",
      },
      {
        role: "tool_result",
        toolCallId: "call",
        toolName: "find",
        content: [
          { type: "text", text: "bad" },
          { type: "image", data: "image", mimeType: "image/png" },
        ],
        isError: true,
        details: { code: "missing", nested: [1] },
      },
    ]);
  });
  it("delivers all trailing tool results by their original ids regardless of ordering", () => {
    const toolResults: Context = {
      messages: [
        { role: "user", content: "go", timestamp: 0 },
        ...["second", "first"].map((id) => ({
          role: "toolResult" as const,
          toolCallId: id,
          toolName: "edit",
          content: [{ type: "text" as const, text: id }],
          isError: false,
          timestamp: 0,
        })),
      ],
    };
    expect(
      toRequest(model, toolResults, {}, configuration, session, "/project")
        .input,
    ).toMatchObject({
      kind: "tool-results",
      results: [{ toolCallId: "second" }, { toolCallId: "first" }],
    });
  });
  it("honors actual cwd, retains the prompt once in transcript and leaves Haiku effort unset", () => {
    expect(request({ cwd: "/override" })).toMatchObject({
      cwd: "/override",
      systemPrompt: "one\n\ntwo",
      transcript: [
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
      input: { kind: "prompt", content: [{ type: "text", text: "hello" }] },
      settings: { effort: undefined },
    });
  });
  it("validates payload replacements and preserves auth/session boundaries", () => {
    const original = request();
    expect(
      replacePayload(original, { ...original, systemPrompt: "updated" })
        .systemPrompt,
    ).toBe("updated");
    expect(() =>
      replacePayload(original, {
        ...original,
        auth: { mode: "api-key", apiKey: "secret" },
      }),
    ).toThrow("can't replace auth");
    expect(() =>
      replacePayload(original, { ...original, tools: [{}] }),
    ).toThrow("Invalid OMP payload tools");
    expect(() =>
      replacePayload(original, {
        ...original,
        input: { kind: "prompt", content: [{ type: "image" }] },
      }),
    ).toThrow("Invalid OMP payload input");
  });
  it("redacts hook credentials without changing driver auth and restricts tool inventory", () => {
    const secret = {
      ...request(),
      auth: { mode: "api-key" as const, apiKey: "private-key" },
    };
    const publicRequest = payloadForHook(secret);
    expect(publicRequest.auth).toEqual({
      mode: "api-key",
      apiKey: "[redacted]",
    });
    expect(
      replacePayload(secret, { ...publicRequest, systemPrompt: "hook" }).auth,
    ).toEqual(secret.auth);
    expect(() =>
      replacePayload(secret, {
        ...publicRequest,
        tools: [
          { owner: "host", name: "injected", description: "", inputSchema: {} },
        ],
      }),
    ).toThrow("effective inventory subset");
    expect(() =>
      replacePayload(secret, {
        ...publicRequest,
        auth: { mode: "api-key", apiKey: "replacement" },
      }),
    ).toThrow("can't replace auth");
  });
  it("preserves MCP structured content and metadata alongside native details", () => {
    const details = {
      structuredContent: { matches: 2 },
      _meta: { correlation: "native" },
      view: "table",
    };
    const [result] = normalizeTranscript({
      messages: [
        {
          role: "toolResult",
          toolCallId: "id",
          toolName: "query",
          content: [],
          details,
          isError: false,
          timestamp: 0,
        },
      ],
    });
    expect(result).toMatchObject({
      structuredContent: details.structuredContent,
      _meta: details._meta,
      details,
    });
  });
  it("rejects explicit effort when a model can't reason", () => {
    expect(() =>
      toRequest(
        model,
        context,
        {},
        {
          ...configuration,
          settings: { ...configuration.settings, effort: "high" },
        },
        session,
        "/project",
      ),
    ).toThrow("doesn't support Claude effort");
  });
  it("keeps prompt-hook edits synchronized with the trailing transcript prompt", () => {
    const original = request();
    const replacement = replacePayload(original, {
      ...payloadForHook(original),
      input: { kind: "prompt", content: [{ type: "text", text: "edited" }] },
    });
    expect(replacement.transcript.at(-1)).toEqual({
      role: "user",
      content: [{ type: "text", text: "edited" }],
    });
    expect(replacement.input).toEqual({
      kind: "prompt",
      content: [{ type: "text", text: "edited" }],
    });
  });
});
