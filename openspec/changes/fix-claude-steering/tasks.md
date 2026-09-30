# Tasks

All tasks are tracked by bead `pcc-6se`; evidence is recorded in `execution.md`.

- [x] Reproduce unsolicited status output with an empty native queue and remove the trigger.
- [x] Research pinned/current Claude CLI/SDK and T3 Code steering semantics.
- [x] Implement safe same-turn `next` admission before original host tool results.
- [x] Isolate ownership-free extension completions from main native sessions and route abort cleanup failures natively (`pcc-go6`).
- [ ] Verify receipt/lifecycle regressions, offline gates and all four real host/driver boundary cases.
- [ ] Publish the validated fix and update managed Toolbox package pins for live use.
