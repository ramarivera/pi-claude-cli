# Claude session and prompt-cache audit

Audit date: October 1, 2026. Tracked by `pcc-k4z`; tool inventory repair by `pcc-6vb`. An independent Sol 6.1/high reviewer inspected both drivers, shared history reconciliation, cache accounting and the installed OMP trace. Source fixes and offline proofs aren't evidence that the user's installed workload is fixed.

## Confirmed defects

1. Native OMP hooks can revise a tool call's recorded arguments before execution. The shared core compared that assistant message with Claude's original proposal exactly, rejected the acknowledgement and reopened Claude with user-history replay. A real OMP Agent probe reproduced `fresh → replay` using installed 0.4.3, and retained one resident driver with the repair for both transport profiles. The probe uses scripted Claude packets, actual native dispatch/conversion and no inference. The repair permits argument differences only for newly completed, correlated, released proposals with matching IDs and names. Other message fields and previously acknowledged history remain exact. Claude's original history isn't rewritten.
2. OMP's redacted-thinking projection dropped the opaque bytes and reconstructed a different neutral message. The repair preserves those bytes through native stream/snapshot projection and normalization, keeping the history digest identical. Pi's existing representation remains intact. Native conversion, streaming and Pi round-trip regressions cover this path. The inspected problematic trace contained ordinary signed thinking, so this second defect doesn't explain that interval.

The independent reviewer checked the argument-revision repair and ran its 13 regressions, including wrong IDs/names, changed text/thinking/signatures/order, duplicate results and changes to older history.

## What the installed trace establishes

After one host compaction, a sequence of tool rounds seconds apart repeatedly reported 69,790 cache-read tokens while single-step cache writes grew from 29,244 to 128,125. This is a serious cache-performance signal. Positive cache reads alone don't establish healthy history-prefix reuse. Multi-step host rows aggregate native assistant steps and can hide an initial miss; their token totals aren't a single request's context-window size.

The trace doesn't retain raw native request packets, session reopen reasons or effective request fingerprints. No swapped cache-read/write fields or clear cumulative-usage accounting error was found. Repeated replay or changing prefixes would fit the pattern, but the trace doesn't prove its full cause. The argument-revision reproduction establishes one concrete replay trigger; it doesn't establish that every observed miss came from it. Server-side behavior remains unverified.

## BB and T3Code comparison

References were refreshed and pinned before inspection:

| Reference                                                                                                                                                   | Continuity pattern                                                                                                  | Difference from this extension                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [BB SDK session](https://github.com/get-bb/bb/blob/1d7e1dc3a1a9e105b928bb0c1744a0d0755c95ea/plugins/provider-claude-code/src/bridge/sdk-session.ts)         | Retains one query and input iterable, queues later prompts, persists sessions and supplies native resume            | Our SDK path also retains one query and input queue; verified restoration after process restart isn't implemented |
| [T3Code Claude adapter](https://github.com/pingdotgg/t3code/blob/0cf482b08bca0249ec94fbcbd0eb04fff28d9b3d/apps/server/src/provider/Layers/ClaudeAdapter.ts) | Retains query plus prompt queue, sets a stable prompt at construction, persists a resume cursor with assistant UUID | Our resident path follows that structure, but reconciles a separate Pi/OMP-owned transcript before reuse          |

Neither reference's architecture proves its actual cache hit rate. Both preserve separate uncached/read/write usage. Our CLI keeps the same `claude -p` stream-json process across matching rounds, and our SDK keeps the same query. The CLI's `--no-session-persistence` disables durable transcript storage, not resident context. On matching rounds only current input is sent. Tool/system/configuration changes and host compaction intentionally invalidate resident state; ordinary rounds don't do so. After close or restart the current core uses labelled user-history replay, not verified native resume.

The native tool-name appendix is stable for an unchanged exposed inventory and contains no timestamps or per-round IDs. Native host instructions remain its exact prefix. Object key order and pure tool inventory order don't invalidate the core fingerprint; meaningful string, schema, authentication and settings changes do.

## Verification and remaining gate

Offline probes verify accounting with nonzero native usage, resident plan selection, native hook argument revisions and opaque-thinking round trips. They don't measure Anthropic's server cache. Earlier paid OMP CLI/SDK background/follow-up checks reported positive cache reads, but used production fingerprint `bdf8a911ff61df0249c893b238c77151fb6d72fd066a9681ebd540486a18e03f` before these repairs and don't validate the large-conversation pattern.

The opt-in `tests/e2e/cache.test.mjs` covers Pi/OMP × CLI/SDK using actual native default prompts: a large synthetic reference, a warm no-tool follow-up, one native bash call whose arguments a native hook rewrites, and another warm follow-up. It requires one successful correlated execution/rewrite, remembered synthetic output, stable Claude identity, a nonshrinking warm cached prefix of at least 4096 tokens, and cache writes below one quarter of cache reads on the two no-tool warm turns. Tool-round usage is a host aggregate; this bounded check doesn't claim to reproduce the user's long conversation or expose raw per-step server usage.

New paid default-prompt discovery checks failed with explicit Anthropic session-limit/extra-usage errors before any tool execution. The final-fingerprint cache matrix, default-prompt read/edit/write matrix, publication and installed checks remain incomplete. Release 0.4.4 stays unpublished until the live gates pass. Further investigation of the large trace needs first-step usage and declared reopen reasons if the same pattern persists after the confirmed fixes.

Anthropic's [prompt caching guide](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) documents identical cached prefixes, minimum lengths and cache lifetimes; its [SDK sessions guide](https://code.claude.com/docs/en/agent-sdk/sessions) describes persistence/resume. Session continuity and server-side prompt caching are distinct mechanisms. No unconditional cache guarantee or subscription billing claim follows from this audit.
