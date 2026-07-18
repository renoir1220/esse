export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Semaphore limit must be a positive integer.");
  }

  async use<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try { return await task(); }
    finally { this.release(); }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(() => { this.active += 1; resolve(); }));
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}
