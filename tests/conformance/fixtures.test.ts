import { describe, expect, it } from "vitest";
import { createClaudeEventNormalizer } from "../../src/core/index.js";
import type { UnsequencedClaudeDriverEvent } from "../../src/contracts/index.js";
import {
  loadFixtureCatalog,
  projectMainContent,
} from "../support/fixture-catalog.js";

const catalog = loadFixtureCatalog();

describe("versioned synthetic Claude protocol fixtures (offline)", () => {
  it("declares versions, flags and truthful provenance", () => {
    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.fixtureVersion).toBe("1.1.0");
    expect(catalog.provenance).toMatchObject({
      kind: "synthetic",
      license: "MIT",
      capturedAt: null,
    });
    expect(catalog.targets).toEqual({
      claudeCli: "2.1.285",
      claudeAgentSdk: "0.3.285",
      pi: "0.99.1",
      omp: "18.4.4",
    });
    expect(catalog.flags.sdk.includePartialMessages).toBe(true);
    expect(catalog.flags.cli).toContain("--include-partial-messages");
    const covered = new Set(
      catalog.cases.flatMap((fixture) => fixture.coverage),
    );
    for (const family of [
      "lifecycle",
      "initialization-error",
      "retry",
      "rate-limit",
      "compaction",
      "full-assistant",
      "signature",
      "subagent",
      "task",
      "unknown-frame",
      "malformed",
      "abort",
      "terminal-once",
      "dedupe",
      "native-schema",
      "bounded-core-diagnostic",
    ])
      expect(covered, `Missing ${family} scenario`).toContain(family);
  });

  it.each(catalog.cases)("$id", (fixture) => {
    const normalizer = createClaudeEventNormalizer(catalog.normalizerOptions);
    const all: UnsequencedClaudeDriverEvent[] = [];
    for (const [index, frame] of fixture.frames.entries()) {
      const events = normalizer.normalize(frame.payload);
      // Exact count/type catches extra terminals, diagnostics and lost frames.
      expect(
        events.map((event) => event.type),
        `${fixture.id} frame ${index}`,
      ).toEqual(frame.expected.map((event) => event.type));
      expect(events, `${fixture.id} frame ${index}`).toMatchObject(
        frame.expected,
      );
      for (const [eventIndex, expected] of frame.expected.entries()) {
        if (
          expected.type === "observation" &&
          typeof expected.subtype === "string" &&
          expected.subtype.startsWith("core-")
        )
          // Full equality rejects unexpected content/input fields in safe metadata.
          expect(
            events[eventIndex],
            `${fixture.id} frame ${index} diagnostic ${eventIndex}`,
          ).toEqual(expected);
      }
      all.push(...events);
    }
    expect(
      all
        .filter((event) => event.type === "turn_end")
        .map((event) => event.status),
    ).toEqual(fixture.outcome.terminalStatuses);
    const content = projectMainContent(all);
    if (fixture.outcome.text !== undefined)
      expect(
        content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join(""),
      ).toBe(fixture.outcome.text);
    if (fixture.outcome.thinking !== undefined)
      expect(
        content
          .filter((block) => block.type === "thinking")
          .map(({ type: _type, ...block }) => block),
      ).toEqual(fixture.outcome.thinking);
    if (fixture.outcome.toolCalls !== undefined)
      expect(content.filter((block) => block.type === "tool_call")).toEqual(
        fixture.outcome.toolCalls,
      );
    if (fixture.outcome.hostToolRequests !== undefined)
      expect(
        all.filter((event) => event.type === "host_tool_request"),
      ).toHaveLength(fixture.outcome.hostToolRequests);
    for (const forbidden of fixture.outcome.forbiddenOutput ?? [])
      expect(JSON.stringify(all)).not.toContain(forbidden);
  });
});
