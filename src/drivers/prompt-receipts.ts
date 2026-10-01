import { randomUUID } from "node:crypto";

interface Pending {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Pinned native queue admission; writing stdin doesn't prove input was queued. */
export class PromptReceipts {
  private readonly pending = new Map<string, Pending>();
  private readonly admitted = new Set<string>();
  constructor(
    private readonly observe?: (
      commandId: string,
      state: "queued" | "started",
    ) => void,
  ) {}

  register(
    timeoutMs: number,
    commandId = randomUUID() as string,
  ): {
    uuid: ReturnType<typeof randomUUID>;
    accepted: Promise<void>;
  } {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        commandId,
      )
    )
      throw new Error("Steering command requires a UUID");
    const uuid = commandId as ReturnType<typeof randomUUID>;
    if (this.pending.has(uuid) || this.admitted.has(uuid))
      throw new Error("Duplicate steering command UUID");
    const accepted = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(uuid);
        reject(new Error("Claude didn't acknowledge queued steering"));
      }, timeoutMs);
      this.pending.set(uuid, { resolve, reject, timer });
    });
    // Shutdown can reject while the transport write is still pending.
    void accepted.catch(() => {});
    return { uuid, accepted };
  }

  handle(packet: unknown): boolean {
    if (typeof packet !== "object" || packet === null) return false;
    const value = packet as Record<string, unknown>;
    if (value.type !== "command_lifecycle") return false;
    if (typeof value.command_uuid !== "string") return true;
    const pending = this.pending.get(value.command_uuid);
    if (pending && value.state === "queued") {
      clearTimeout(pending.timer);
      this.pending.delete(value.command_uuid);
      // Keep only a bounded recent admission history for consumption diagnostics.
      if (this.admitted.size >= 128)
        this.admitted.delete(this.admitted.values().next().value!);
      this.admitted.add(value.command_uuid);
      this.observe?.(value.command_uuid, "queued");
      pending.resolve();
    } else if (
      value.state === "started" &&
      this.admitted.delete(value.command_uuid)
    ) {
      this.observe?.(value.command_uuid, "started");
    }
    // Internal admission bookkeeping isn't a user-facing observation.
    return true;
  }

  cancel(uuid: string, reason: string): void {
    const pending = this.pending.get(uuid);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(uuid);
    pending.reject(new Error(reason));
  }

  close(): void {
    this.admitted.clear();
    for (const uuid of this.pending.keys())
      this.cancel(uuid, "Claude session closed before steering was queued");
  }
}
