/** One subscriber owns each provider round; the driver pump never stops with it. */
export class Channel<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private wake?: () => void;
  private ended = false;
  push(value: T): void {
    if (this.ended) return;
    this.values.push(value);
    this.wake?.();
    this.wake = undefined;
  }
  end(): void {
    this.ended = true;
    this.wake?.();
    this.wake = undefined;
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (this.values.length || !this.ended) {
      if (this.values.length) yield this.values.shift() as T;
      else
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
    }
  }
}
