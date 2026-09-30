import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeContext,
  Type,
  type Message as PiMessage,
  type AssistantMessage as PiAssistant,
  type Api as PiApi,
  type Model as PiModel,
} from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  ExtensionAPI as PiAPI,
  ProviderConfig as PiProvider,
} from "@earendil-works/pi-coding-agent";
import type {
  Message as OmpMessage,
  AssistantMessage as OmpAssistant,
  Model as OmpModel,
} from "@oh-my-pi/pi-ai";
import type {
  ExtensionAPI as OmpAPI,
  ProviderConfig as OmpProvider,
} from "@oh-my-pi/pi-coding-agent";
import type { DriverKind, HostToolResult } from "../../src/contracts/index.js";
import { createClaudeRuntime } from "../../src/core/index.js";
import { readRuntimeConfiguration } from "../../entrypoints/config.js";
import { registerPiAdapter } from "../../src/adapters/pi/index.js";
import {
  nativeTool,
  productionDriver,
  toolArguments,
  toolResult,
} from "../support/production-drivers.js";
import type { ScenarioCommand } from "../support/protocol-scenario.mjs";

// Node can't load OMP's Bun provider barrel. Keep its real stream/catalog modules
// and the exact installed VERSION; only the extension API boundary is simulated.
vi.mock(
  "@oh-my-pi/pi-utils",
  async () => import("@oh-my-pi/pi-utils/fetch-retry"),
);
vi.mock("@oh-my-pi/pi-ai", async () => {
  const stream = await import("@oh-my-pi/pi-ai/utils/event-stream");
  const catalog = await import("@oh-my-pi/pi-catalog/models");
  return {
    createAssistantMessageEventStream: stream.createAssistantMessageEventStream,
    getBundledModels: catalog.getBundledModels,
  };
});
vi.mock("@oh-my-pi/pi-coding-agent", async () => {
  const { readFileSync } = await import("node:fs");
  const packageMetadata: unknown = JSON.parse(
    readFileSync(
      new URL(
        "../../node_modules/@oh-my-pi/pi-coding-agent/package.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  if (
    !packageMetadata ||
    typeof packageMetadata !== "object" ||
    !("version" in packageMetadata) ||
    typeof packageMetadata.version !== "string"
  )
    throw new Error("Installed OMP package version missing");
  return { VERSION: packageMetadata.version };
});
import { registerOmpAdapter } from "../../src/adapters/omp/index.js";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";

const dispose: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of dispose.splice(0).reverse()) await close();
});

async function boundary(host: "pi" | "omp", kind: DriverKind) {
  const owner = await productionDriver(kind);
  dispose.push(owner.cleanup);
  const runtime = createClaudeRuntime({ driver: owner.driver });
  dispose.push(() => runtime.closeAll());
  const configuration = readRuntimeConfiguration({
    PI_CLAUDE_DRIVER: kind,
    PI_CLAUDE_TOOL_TIMEOUT_MS: "2000",
    PI_CLAUDE_MAX_TURNS: "3",
  });
  const responses: { status: number; headers?: Record<string, string> }[] = [];
  const hooks = new Map<
    string,
    (event: unknown, context: unknown) => unknown
  >();
  const on = (
    name: string,
    handler: (event: unknown, context: unknown) => unknown,
  ) => {
    hooks.set(name, handler);
  };
  const context = {
    cwd: process.cwd(),
    sessionManager: { getSessionId: () => "native-host-session" },
    agent: { kind: "main", id: "Main", name: "main", depth: 0 },
    ui: { setStatus: () => {} },
  };
  const runtimeFactory = vi.fn(async () => runtime);
  if (host === "pi") {
    let provider: PiProvider | undefined;
    const native = {
      on,
      registerProvider: (id: string, config: PiProvider) => {
        expect(id).toBe("pi-claude-cli");
        provider = config;
      },
      getAllTools: () => {
        throw new Error("Must use effective transcript inventory");
      },
      setActiveTools: () => {
        throw new Error("Must preserve host tool policy");
      },
    } as unknown as PiAPI;
    registerPiAdapter(native, { configuration, runtimeFactory });
    await hooks.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      context,
    );
    if (!provider?.streamSimple)
      throw new Error("Native Pi stream factory missing");
    const streamSimple = provider.streamSimple;
    const base = getBuiltinModels("anthropic").find(
      (model) => model.id === "claude-haiku-4-5-20251001",
    );
    if (!base)
      throw new Error("Pinned Pi catalog lacks expected supported Haiku model");
    const model: PiModel<PiApi> = {
      ...base,
      id: "offline-model",
      api: "pi-claude-cli",
      provider: "pi-claude-cli",
    };
    const history: PiMessage[] = [];
    const run = async () => {
      const stream = streamSimple(
        model,
        normalizeContext({
          systemPrompt: "Native host distinctive marker",
          tools: [
            {
              name: nativeTool.name,
              description: nativeTool.description,
              parameters: Type.Unsafe(nativeTool.inputSchema),
            },
          ],
          messages: history,
        }),
        {
          onResponse: (response) => {
            responses.push(response);
          },
        },
      );
      const events: { type: string }[] = [];
      for await (const event of stream) events.push(structuredClone(event));
      const message: PiAssistant = await stream.result();
      history.push(message);
      return { events, message };
    };
    return {
      ...owner,
      runtime,
      responses,
      runtimeFactory,
      registeredModels: provider.models,
      async prompt(command: ScenarioCommand) {
        history.push({
          role: "user",
          content: JSON.stringify(command),
          timestamp: Date.now(),
        });
        return run();
      },
      async results(results: HostToolResult[]) {
        for (const result of results)
          history.push({
            role: "toolResult",
            toolCallId: result.toolCallId,
            toolName: result.toolName,
            content: [...result.content].filter(
              (content) => content.type === "text" || content.type === "image",
            ),
            isError: result.isError,
            details: {
              ...(result.details as object),
              ...(result.structuredContent
                ? { structuredContent: result.structuredContent }
                : {}),
              ...(result._meta ? { _meta: result._meta } : {}),
            },
            timestamp: Date.now(),
          });
        return run();
      },
    };
  }
  let provider: OmpProvider | undefined;
  const native = {
    on,
    registerProvider: (id: string, config: OmpProvider) => {
      expect(id).toBe("pi-claude-cli");
      provider = config;
    },
  } as unknown as OmpAPI;
  registerOmpAdapter(native, { configuration, runtimeFactory });
  await hooks.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    context,
  );
  if (!provider?.streamSimple)
    throw new Error("Native OMP stream factory missing");
  const streamSimple = provider.streamSimple;
  const base = getBundledModels("anthropic").find(
    (model) => model.id === "claude-haiku-4-5-20251001",
  );
  if (!base)
    throw new Error("Pinned OMP catalog lacks expected supported Haiku model");
  const model: OmpModel = {
    ...base,
    id: "offline-model",
    api: "pi-claude-cli",
    provider: "pi-claude-cli",
  };
  const history: OmpMessage[] = [];
  const run = async () => {
    const stream = streamSimple(
      model,
      {
        systemPrompt: ["Native host distinctive marker"],
        tools: [
          {
            name: nativeTool.name,
            description: nativeTool.description,
            parameters: nativeTool.inputSchema,
            customWireName: "edit",
            customFormat: { syntax: "lark", definition: "start: /.+/" },
          },
        ],
        messages: history,
      },
      {
        onResponse: (response) => {
          responses.push(response);
        },
      },
    );
    const events: { type: string }[] = [];
    for await (const event of stream) events.push(structuredClone(event));
    const message: OmpAssistant = await stream.result();
    history.push(message);
    return { events, message };
  };
  return {
    ...owner,
    runtime,
    responses,
    runtimeFactory,
    registeredModels: provider.models,
    async prompt(command: ScenarioCommand) {
      history.push({
        role: "user",
        content: JSON.stringify(command),
        timestamp: Date.now(),
      });
      return run();
    },
    async results(results: HostToolResult[]) {
      for (const result of results)
        history.push({
          role: "toolResult",
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          content: [...result.content].filter(
            (content) => content.type === "text" || content.type === "image",
          ),
          isError: result.isError,
          details: {
            ...(result.details as object),
            ...(result.structuredContent
              ? { structuredContent: result.structuredContent }
              : {}),
            ...(result._meta ? { _meta: result._meta } : {}),
          },
          timestamp: Date.now(),
        });
      return run();
    },
  };
}

for (const host of ["pi", "omp"] as const)
  for (const kind of ["cli", "sdk"] satisfies DriverKind[]) {
    describe(`${host} + ${kind} native factory / production runtime (offline inference)`, () => {
      it("projects semantic text/system prompt and reuses the authoritative resident session across a second native prompt", async () => {
        const t = await boundary(host, kind);
        expect(
          t.registeredModels?.some(
            (model) => model.id === "claude-haiku-4-5-20251001",
          ),
        ).toBe(true);
        for (const turn of ["first", "second"]) {
          const result = await t.prompt({
            turn,
            mode: "text",
            text: `native-${host}-${kind}-${turn}`,
          });
          expect(
            result.events.filter(
              (event) => event.type === "done" || event.type === "error",
            ),
          ).toHaveLength(1);
          expect(result.message.stopReason).toBe("stop");
          expect(result.message.content).toEqual([
            { type: "text", text: `native-${host}-${kind}-${turn}` },
          ]);
        }
        expect(t.captures).toHaveLength(1);
        expect(t.runtimeFactory).toHaveBeenCalledTimes(1);
        expect(t.captures[0].request.systemPrompt).toBe(
          "Native host distinctive marker",
        );
        expect(t.captures[0].request.identity.sessionId).toBe(
          "native-host-session",
        );
        expect(t.captures[0].request.identity.cwd).toBe(process.cwd());
        expect(t.responses).toHaveLength(2);
        for (const response of t.responses)
          expect(response).toMatchObject({
            status: 0,
            headers: {
              "x-pi-claude-driver": kind,
              "x-pi-claude-session-id": expect.stringMatching(/^offline-/),
            },
          });
        expect(t.responses[1].headers?.["x-pi-claude-session-id"]).toBe(
          t.responses[0].headers?.["x-pi-claude-session-id"],
        );
      });

      it("returns native tool calls once and uses correlated host results in the next native provider round", async () => {
        const t = await boundary(host, kind);
        const first = await t.prompt({
          turn: "tools",
          mode: "tools",
          calls: ["native-a", "native-b"].map((id) => ({
            id,
            name: "edit",
            arguments: toolArguments,
          })),
        });
        expect(first.message.stopReason).toBe("toolUse");
        expect(
          first.events.filter(
            (event) => event.type === "done" || event.type === "error",
          ),
        ).toHaveLength(1);
        expect(first.message.content).toEqual([
          {
            type: "toolCall",
            id: "native-a",
            name: "edit",
            arguments: toolArguments,
          },
          {
            type: "toolCall",
            id: "native-b",
            name: "edit",
            arguments: toolArguments,
          },
        ]);
        expect(t.captures[0].request.tools[0].inputSchema).toEqual(
          nativeTool.inputSchema,
        );
        if (host === "omp")
          expect(t.captures[0].request.tools[0]._meta).toMatchObject({
            omp: {
              customWireName: "edit",
              customFormat: { syntax: "lark", definition: "start: /.+/" },
            },
          });
        const final = await t.results([
          toolResult("native-b"),
          toolResult("native-a"),
        ]);
        expect(final.message.stopReason).toBe("stop");
        expect(final.message.content).toEqual([
          {
            type: "text",
            text: 'native-a:{"nonce":"nonce-native-a"}:false|native-b:{"nonce":"nonce-native-b"}:false',
          },
        ]);
        expect(
          final.events.filter(
            (event) => event.type === "done" || event.type === "error",
          ),
        ).toHaveLength(1);
        expect(t.captures).toHaveLength(1);
        expect(t.responses).toHaveLength(2);
      });

      it("projects one actionable native error from the selected driver", async () => {
        const t = await boundary(host, kind);
        const result = await t.prompt({ turn: "failed", mode: "error" });
        expect(result.message.stopReason).toBe("error");
        expect(result.message.errorMessage).toContain(
          "Offline controlled exhaustion",
        );
        expect(
          result.events
            .filter((event) => event.type === "done" || event.type === "error")
            .map((event) => event.type),
        ).toEqual(["error"]);
        expect(t.captures).toHaveLength(1);
        expect(t.captures[0].request.identity.driver).toBe(kind);
      });
    });
  }
