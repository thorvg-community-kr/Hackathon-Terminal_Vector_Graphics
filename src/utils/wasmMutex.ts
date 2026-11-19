/**
 * 단일 TermVGEngine(WASM 싱글턴) 상태 경합을 방지하는 FIFO 비동기 뮤텍스 큐.
 */
export class AsyncMutex {
  private queue: Promise<void> = Promise.resolve();

  runExclusive<T>(task: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(() => task());
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export const globalWasmMutex = new AsyncMutex();
