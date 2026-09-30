import { StringDecoder } from "node:string_decoder";

/** Bounded UTF-8 NDJSON framing shared by subprocess stdout and private IPC. */
export class JsonLines {
  private decoder = new StringDecoder("utf8");
  private remainder = "";
  constructor(
    private readonly receive: (value: unknown) => void,
    private readonly maxBytes = 1024 * 1024,
  ) {}
  push(chunk: Buffer): void {
    this.remainder += this.decoder.write(chunk);
    this.drain(false);
  }
  end(): void {
    this.remainder += this.decoder.end();
    this.drain(true);
  }
  private drain(final: boolean): void {
    for (;;) {
      const newline = this.remainder.indexOf("\n");
      if (newline < 0) break;
      const line = this.remainder.slice(0, newline);
      this.remainder = this.remainder.slice(newline + 1);
      this.parse(line);
    }
    if (Buffer.byteLength(this.remainder) > this.maxBytes)
      throw new Error("NDJSON frame exceeds byte limit");
    if (final && this.remainder.trim()) {
      const line = this.remainder;
      this.remainder = "";
      this.parse(line);
    }
  }
  private parse(line: string): void {
    if (Buffer.byteLength(line) > this.maxBytes)
      throw new Error("NDJSON frame exceeds byte limit");
    if (line.trim()) this.receive(JSON.parse(line) as unknown);
  }
}

export class EventQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiter: ((value: IteratorResult<T>) => void) | undefined;
  private ended = false;
  push(value: T): void {
    if (this.ended) return;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ value, done: false });
    } else this.items.push(value);
  }
  end(): void {
    this.ended = true;
    this.waiter?.({ value: undefined, done: true });
    this.waiter = undefined;
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.items.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.ended)
          return Promise.resolve({ value: undefined, done: true });
        if (this.waiter)
          return Promise.reject(
            new Error("Driver events support one consumer"),
          );
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}
