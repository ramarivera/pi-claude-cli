import { describe, expect, it, vi } from "vitest";
import type {
  Context,
  Model,
  Tool,
  SimpleStreamOptions,
  LiveSteerClaim,
} from "@oh-my-pi/pi-ai";
import {
  payloadForHook,
  normalizeTools,
  normalizeTranscript,
  normalizeActiveSteering,
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
  it("attaches the active channel only to persistent provider calls and preserves it across hooks", () => {
    const liveSteering = { wait: vi.fn(), claim: vi.fn() };
    expect(request({ liveSteering }).activeSteering).toBeUndefined();
    const original = request({ liveSteering, sessionId: "host" });
    expect(original.activeSteering).toBeDefined();
    expect(
      request({ liveSteering, providerSessionState: new Map() }).activeSteering,
    ).toBeDefined();
    const payload = payloadForHook(original);
    expect(payload.activeSteering).toBeUndefined();
    const replacement = replacePayload(original, payload);
    expect(replacement.activeSteering).toBe(original.activeSteering);
    expect(liveSteering.claim).not.toHaveBeenCalled();
  });
  it("transfers text and image content without native types and settles a claim only once", async () => {
    const accept = vi.fn();
    const reject = vi.fn();
    const native: LiveSteerClaim = {
      messages: [
        { role: "user", content: "correction", timestamp: 0, steering: true },
        {
          role: "user",
          content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
          timestamp: 1,
        },
      ],
      accept,
      reject,
    };
    const source = normalizeActiveSteering({
      wait: vi.fn(),
      claim: vi.fn(async () => native),
    });
    const claim = await source.claim(new AbortController().signal);
    expect(claim?.contents).toEqual([
      [{ type: "text", text: "correction" }],
      [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
    ]);
    expect(accept).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
    claim?.accept();
    claim?.reject();
    claim?.accept();
    expect(accept).toHaveBeenCalledOnce();
    expect(reject).not.toHaveBeenCalled();
  });
  it.each([
    { messages: [{ role: "assistant", content: "wrong role", timestamp: 0 }] },
    {
      messages: [
        {
          role: "user",
          content: [{ type: "audio", data: "YQ==", mimeType: "audio/wav" }],
          timestamp: 0,
        },
      ],
    },
    {
      messages: [
        {
          role: "user",
          content: "opaque",
          providerPayload: { type: "unknown" },
          timestamp: 0,
        },
      ],
    },
    {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              url: "https://example.test/image.png",
              mimeType: "image/png",
            },
          ],
          timestamp: 0,
        },
      ],
    },
    { messages: [] },
  ])(
    "returns unsupported active input to the host queue without accepting it: %j",
    async ({ messages }) => {
      const accept = vi.fn();
      const reject = vi.fn();
      const source = normalizeActiveSteering({
        wait: vi.fn(),
        claim: vi.fn(
          async () =>
            ({ messages, accept, reject }) as unknown as LiveSteerClaim,
        ),
      });
      await expect(source.claim(new AbortController().signal)).rejects.toThrow(
        /OMP active steering/,
      );
      expect(accept).not.toHaveBeenCalled();
      expect(reject).toHaveBeenCalledOnce();
    },
  );
  it("rejects a claim that arrives after the active response aborts", async () => {
    const controller = new AbortController();
    const accept = vi.fn();
    const reject = vi.fn();
    const claim = vi.fn(async () => {
      controller.abort();
      return {
        messages: [{ role: "user" as const, content: "late", timestamp: 0 }],
        accept,
        reject,
      };
    });
    const source = normalizeActiveSteering({ wait: vi.fn(), claim });
    expect(await source.claim(controller.signal)).toBeUndefined();
    expect(reject).toHaveBeenCalledOnce();
    expect(accept).not.toHaveBeenCalled();
    await source.claim(controller.signal);
    expect(claim).toHaveBeenCalledOnce();
  });
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
  it("maps native output token bounds and rejects invalid bounds", () => {
    expect(request({ maxTokens: 4096 }).settings.maxOutputTokens).toBe(4096);
    expect(() => request({ maxTokens: 0 })).toThrow("positive safe integer");
    expect(() => request({ maxTokens: Number.POSITIVE_INFINITY })).toThrow(
      "positive safe integer",
    );
  });
  it("keeps configured output bounds when native OMP supplies a larger default", () => {
    const bounded = {
      ...configuration,
      settings: { ...configuration.settings, maxOutputTokens: 512 },
    };
    const configuredRequest = (maxTokens?: number) =>
      toRequest(model, context, { maxTokens }, bounded, session, "/project");
    expect(configuredRequest(64000).settings.maxOutputTokens).toBe(512);
    expect(configuredRequest(256).settings.maxOutputTokens).toBe(256);
    expect(configuredRequest().settings.maxOutputTokens).toBe(512);
  });
  it("retains all tool results when native boundary steering follows them", () => {
    const mixed: Context = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "id", name: "edit", arguments: {} },
          ],
          stopReason: "toolUse",
          timestamp: 0,
        } as Context["messages"][number],
        {
          role: "toolResult",
          toolCallId: "id",
          toolName: "edit",
          content: [],
          isError: false,
          timestamp: 1,
        },
        { role: "user", content: "new instruction", timestamp: 2 },
      ],
    };
    expect(
      toRequest(model, mixed, {}, configuration, session, "/project").input,
    ).toMatchObject({
      kind: "tool-results",
      results: [{ toolCallId: "id" }],
      steering: [{ type: "text", text: "new instruction" }],
    });
  });
  it("accepts real OMP default controls and rejects concrete unsupported overrides", () => {
    const httpFetch = () => {
      throw new Error("Claude subprocess mustn't invoke OMP HTTP fetch");
    };
    expect(() =>
      request({
        fetch: httpFetch,
        thinkingBudgets: {
          minimal: 1024,
          low: 2048,
          medium: 8192,
          high: 16384,
          xhigh: 32768,
          max: 32768,
        },
        disableReasoning: false,
        hideThinkingSummary: false,
        maxRetryDelayMs: 60000,
        maxTokens: 64000,
        streamFirstEventTimeoutMs: 100000,
        streamIdleTimeoutMs: 120000,
        loopGuard: { enabled: true, checkAssistantContent: false },
      }),
    ).not.toThrow();
    expect(() => request({ temperature: 0.2 })).toThrow(
      "option temperature isn't supported",
    );
    expect(() => request({ headers: { Authorization: "host-auth" } })).toThrow(
      "option headers isn't supported",
    );
  });
});
