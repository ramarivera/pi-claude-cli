import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  InMemoryCredentialStore,
  getCurrentSystemPrompt,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { registerPiAdapter } from "../../../src/adapters/pi/index.js";
import { configuration, runtime } from "./support.js";

describe("native Pi system prompt propagation", () => {
  it("passes the CLI loader's structured system prompt unchanged through the native agent and provider hook", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pcc-pi-system-"));
    const system =
      "For this synthetic sandbox E2E, begin every final answer with SYSTEM-offline-proof. Obey the user's exact tool instructions.";
    const nativeHaiku = getBuiltinModels("anthropic").find(
      (item) => item.id === "claude-haiku-4-5-20251001",
    );
    expect(nativeHaiku).toBeDefined();
    const model = {
      ...nativeHaiku!,
      api: "pi-claude-cli",
      provider: "pi-claude-cli",
    };
    const backend = runtime([
      {
        type: "round_end",
        roundId: "r",
        reason: "stop",
        content: [{ type: "text", text: "synthetic response" }],
        pendingToolCallIds: [],
      },
    ]);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
    });
    let publicPrompt: unknown;
    let nativePrompt = "";
    let hadSectionPreamble = false;
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: join(cwd, "agent"),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      // main.ts maps parsed --system-prompt to this public loader option.
      systemPrompt: system,
      extensionFactories: [
        (pi) => {
          registerPiAdapter(pi, {
            configuration,
            runtimeFactory: async () => backend,
          });
          pi.on("context_with_system", (event) => {
            nativePrompt = getCurrentSystemPrompt(event.messages);
            hadSectionPreamble = event.messages.some(
              (message) =>
                message.role === "system" &&
                message.content === "" &&
                message.sections?.preamble === system,
            );
          });
          pi.on("before_provider_request", (event) => {
            publicPrompt = (event.payload as { systemPrompt?: unknown })
              .systemPrompt;
          });
        },
      ],
    });
    let session:
      | Awaited<ReturnType<typeof createAgentSession>>["session"]
      | undefined;
    try {
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      ({ session } = await createAgentSession({
        cwd,
        agentDir: join(cwd, "agent"),
        model,
        modelRuntime,
        thinkingLevel: "off",
        settingsManager,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        noTools: "all",
      }));
      await session.bindExtensions({});
      const registeredModel = modelRuntime.getModel(model.provider, model.id);
      expect(registeredModel).toBeDefined();
      await session.setModel(registeredModel!);
      session.setThinkingLevel("off");
      await session.prompt("No tools. Reply with the exact word READY.");
      expect(session.messages.at(-1)).toMatchObject({
        role: "assistant",
        stopReason: "stop",
      });
      expect(backend.requests).toHaveLength(1);
      expect(hadSectionPreamble).toBe(true);
      expect(nativePrompt.startsWith(system)).toBe(true);
      expect(publicPrompt).toBe(nativePrompt);
      expect(backend.requests[0].systemPrompt).toBe(nativePrompt);
      expect(backend.requests[0].input).toEqual({
        kind: "prompt",
        content: [
          { type: "text", text: "No tools. Reply with the exact word READY." },
        ],
      });
    } finally {
      session?.dispose();
      await backend.closeAll();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
