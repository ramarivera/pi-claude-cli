import { defineConfig } from "vitest/config";

// Dedicated config for live end-to-end tests that spawn a real `pi` process
// driving the Claude Code CLI. These are intentionally excluded from the unit
// `vitest.config.ts` glob (`**/*.{test,spec}.ts`) by using the `.e2e.ts`
// suffix, so they only run via `npm run test:e2e` — not on every `npm test`.
export default defineConfig({
  test: {
    globals: true,
    include: ["e2e/**/*.e2e.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
