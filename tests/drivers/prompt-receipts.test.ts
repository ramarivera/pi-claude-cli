import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptReceipts } from "../../src/drivers/prompt-receipts.js";

describe("native queued steering receipts", () => {
  it("reports consumption only for previously admitted steering and forgets it on close", async () => {
    const observe = vi.fn();
    const tracker = new PromptReceipts(observe);
    const pending = tracker.register(1000);
    tracker.handle({
      type: "command_lifecycle",
      command_uuid: pending.uuid,
      state: "started",
    });
    expect(observe).not.toHaveBeenCalled();
    tracker.handle({
      type: "command_lifecycle",
      command_uuid: pending.uuid,
      state: "queued",
    });
    await pending.accepted;
    tracker.handle({
      type: "command_lifecycle",
      command_uuid: pending.uuid,
      state: "started",
    });
    tracker.handle({
      type: "command_lifecycle",
      command_uuid: pending.uuid,
      state: "started",
    });
    expect(observe.mock.calls).toEqual([
      [pending.uuid, "queued"],
      [pending.uuid, "started"],
    ]);
    tracker.close();
    tracker.handle({
      type: "command_lifecycle",
      command_uuid: pending.uuid,
      state: "queued",
    });
    expect(observe).toHaveBeenCalledTimes(2);
  });
  let receipts: PromptReceipts;
  beforeEach(() => {
    vi.useFakeTimers();
    receipts = new PromptReceipts();
  });
  afterEach(() => {
    receipts.close();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("only the matching queued UUID acknowledges admission and clears its timer", async () => {
    const first = receipts.register(1000);
    const second = receipts.register(1000);
    const secondAccepted = vi.fn();
    void second.accepted.then(secondAccepted, () => {});
    expect(first.uuid).not.toBe(second.uuid);
    expect(vi.getTimerCount()).toBe(2);

    expect(
      receipts.handle({
        type: "command_lifecycle",
        command_uuid: first.uuid,
        state: "queued",
      }),
    ).toBe(true);
    await expect(first.accepted).resolves.toBeUndefined();
    expect(secondAccepted).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    // A duplicate internal packet doesn't acknowledge another pending prompt.
    expect(
      receipts.handle({
        type: "command_lifecycle",
        command_uuid: first.uuid,
        state: "queued",
      }),
    ).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    receipts.handle({
      type: "command_lifecycle",
      command_uuid: second.uuid,
      state: "queued",
    });
    await expect(second.accepted).resolves.toBeUndefined();
    expect(secondAccepted).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("consumes native lifecycle frames without admitting an unrelated or wrongly staged prompt", async () => {
    const pending = receipts.register(1000);
    const accepted = vi.fn();
    void pending.accepted.then(accepted, () => {});
    for (const packet of [
      { type: "command_lifecycle" },
      { type: "command_lifecycle", command_uuid: 5, state: "queued" },
      { type: "command_lifecycle", command_uuid: "unrelated", state: "queued" },
      { type: "command_lifecycle", command_uuid: pending.uuid },
      {
        type: "command_lifecycle",
        command_uuid: pending.uuid,
        state: "started",
      },
      {
        type: "command_lifecycle",
        command_uuid: pending.uuid,
        state: "completed",
      },
    ])
      expect(receipts.handle(packet)).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(accepted).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    receipts.handle({
      type: "command_lifecycle",
      command_uuid: pending.uuid,
      state: "queued",
    });
    await expect(pending.accepted).resolves.toBeUndefined();
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves ordinary transport events available to the normalizer", () => {
    for (const packet of [
      null,
      undefined,
      "command_lifecycle",
      0,
      [],
      {},
      { type: "user" },
      { type: "stream_event", event: { type: "message_start" } },
      { type: "result", subtype: "success" },
    ])
      expect(receipts.handle(packet)).toBe(false);
  });

  it("rejects missing admission at the deadline and consumes late acknowledgements", async () => {
    const pending = receipts.register(1000);
    const rejected = expect(pending.accepted).rejects.toThrow(
      "Claude didn't acknowledge queued steering",
    );
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(
      receipts.handle({
        type: "command_lifecycle",
        command_uuid: pending.uuid,
        state: "queued",
      }),
    ).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancel rejects only its receipt, preserves the reason, and removes its timer", async () => {
    const cancelled = receipts.register(1000);
    const survivor = receipts.register(1000);
    const rejected = expect(cancelled.accepted).rejects.toThrow(
      "Transport write failed",
    );
    receipts.cancel("unrelated", "unrelated reason");
    expect(vi.getTimerCount()).toBe(2);
    receipts.cancel(cancelled.uuid, "Transport write failed");
    await rejected;
    expect(vi.getTimerCount()).toBe(1);
    receipts.cancel(cancelled.uuid, "duplicate cancellation");
    expect(vi.getTimerCount()).toBe(1);
    receipts.handle({
      type: "command_lifecycle",
      command_uuid: survivor.uuid,
      state: "queued",
    });
    await expect(survivor.accepted).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("close rejects every pending receipt and is safe after admission, cancellation or another close", async () => {
    const admitted = receipts.register(1000);
    receipts.handle({
      type: "command_lifecycle",
      command_uuid: admitted.uuid,
      state: "queued",
    });
    await expect(admitted.accepted).resolves.toBeUndefined();
    const first = receipts.register(1000);
    const second = receipts.register(1000);
    const rejections = [first, second].map(({ accepted }) =>
      expect(accepted).rejects.toThrow(
        "Claude session closed before steering was queued",
      ),
    );
    receipts.close();
    await Promise.all(rejections);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => receipts.close()).not.toThrow();
    expect(() =>
      receipts.cancel(first.uuid, "late cancellation"),
    ).not.toThrow();
    expect(
      receipts.handle({
        type: "command_lifecycle",
        command_uuid: second.uuid,
        state: "queued",
      }),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
