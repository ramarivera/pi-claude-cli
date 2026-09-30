import { appendFileSync } from "node:fs";

/** Only synthetic sandbox content and whitelisted public transport metadata. */
export function record(type: string, data: unknown): void {
  const path = process.env.PCC_E2E_OBSERVATIONS;
  if (!path) throw new Error("PCC_E2E_OBSERVATIONS is required");
  appendFileSync(path, JSON.stringify({ type, data }) + "\n", { mode: 0o600 });
}

export function response(
  status: number,
  headers: Record<string, string>,
): void {
  record("response", {
    status,
    driver: headers["x-pi-claude-driver"],
    claudeSessionId: headers["x-pi-claude-session-id"],
    transport: headers["x-pi-claude-transport"],
  });
}

let calls = 0;
export async function sentinel(toolCallId: string) {
  const nonce = process.env.PCC_E2E_NONCE;
  if (!nonce) throw new Error("PCC_E2E_NONCE is required");
  calls++;
  const structuredContent = { nonce, calls, toolCallId };
  record("sentinel", structuredContent);
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(structuredContent) },
    ],
    details: { structuredContent, _meta: { fixture: "native-live-sentinel" } },
    structuredContent,
  };
}

export async function slow(
  toolCallId: string,
  signal: AbortSignal | undefined,
) {
  record("slow-start", { toolCallId });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      record("slow-effect", { toolCallId });
      resolve();
    }, 30_000);
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      record("slow-abort", { toolCallId });
      reject(new Error("Native E2E slow tool aborted"));
    }
    if (signal?.aborted) aborted();
    else signal?.addEventListener("abort", aborted, { once: true });
  });
  return {
    content: [{ type: "text" as const, text: "slow-effect" }],
    details: {},
  };
}
