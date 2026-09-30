/** Single-consumer queue; ending settles every blocked reader. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private readers: ((value: IteratorResult<T>) => void)[] = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) throw new Error("SDK queue is closed");
    const reader = this.readers.shift();
    if (reader) reader({ done: false, value });
    else this.values.push(value);
  }

  end(discard = false): T[] {
    this.ended = true;
    const discarded = discard ? this.values.splice(0) : [];
    for (const reader of this.readers.splice(0)) {
      reader({ done: true, value: undefined });
    }
    return discarded;
  }

  discard(): T[] {
    return this.values.splice(0);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.ended) return { done: true, value: undefined };
        return new Promise((resolve) => this.readers.push(resolve));
      },
    };
  }
}

export async function withinDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("SDK operation timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
