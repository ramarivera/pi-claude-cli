# Protocol fixtures

`tests/fixtures/claude/v1/catalog.json` is a versioned **synthetic** catalog. Its 17 cases were authored for this repository against the researched Claude CLI 2.1.285 / Agent SDK 0.3.285 envelope contract, with Pi 0.99.1 and OMP 18.4.4 as host targets. They aren't runtime recordings and don't establish live compatibility or account behavior.

The catalog records the partial-event flags, normalizer configuration, source attribution, MIT license, coverage tags, each input frame and its expected normalized output. `capturedAt: null` is intentional. No BB or T3 fixture contents were reused. Future external fixtures must identify the original repository, revision, path and license; live captures must identify actual versions, capture conditions, flags and sanitization. Keep those kinds separate from these authored examples.

Run `npx vitest run tests/conformance/fixtures.test.ts`. The test uses `createClaudeEventNormalizer` from production, verifies each frame's exact output event count/types and explicit semantic fields, then checks terminal count/status, canonical content, tool ownership and privacy expectations. Snapshots replace indexed stream content in the assertion consumer so accumulated text and signatures are checked for duplication. A parsed tool proposal never proves that an MCP handler parked; fixtures explicitly assert zero host requests for proposal-only envelopes.

The catalog covers init and failed MCP status, partial/full text reconciliation, repeated snapshot-only content, images, thinking/signatures/redacted content, five error subtypes plus `is_error`, accounting, retries/rate limits, compaction/status/hooks/user observations, task/subagent attribution, main/child isolation, native arguments and ownership, additive unknown frames, malformed required identifiers, abort races and a subsequent resident turn/reset.

Every credential-looking value is a synthetic marker. Known observations must redact those markers, and unknown frames must expose bounded field diagnostics without their values. No credentials or private conversation captures are present.
