/**
 * Keeps `size` sandboxes going: each loads in the background, takes one run, and is replaced
 * once that run is over, so at most `size` sandbox processes exist at a time. A run waits a
 * little for a free sandbox; past that, the pool is busy.
 */

import { LIMITS } from "./config.ts";
import type { RunRequest, RunResponse } from "./contract.ts";
import { Sandbox } from "./sandbox.ts";

const RETRY_DELAY_MS = 1_000;

export class SandboxPool {
  private ready: Sandbox[] = [];
  private waiting: ((sandbox: Sandbox) => void)[] = [];
  private starting = new Set<Promise<void>>();
  private retries = new Set<ReturnType<typeof setTimeout>>();
  private started = false;
  private closed = false;

  constructor(size: number, private readonly waitSeconds: number = LIMITS.waitSeconds) {
    for (let i = 0; i < size; i++) this.fill();
  }

  /** True once a sandbox has started, which shows the setup works. */
  get healthy(): boolean {
    return this.started;
  }

  /** Runs the request in a free sandbox; null when none frees up in time. */
  async run(request: RunRequest): Promise<RunResponse | null> {
    const sandbox = await this.take();
    if (!sandbox) return null;
    try {
      return await sandbox.run(request);
    } finally {
      this.fill();
    }
  }

  /** Stops every idle sandbox and starts no new ones. */
  async close(): Promise<void> {
    this.closed = true;
    this.retries.forEach(clearTimeout);
    await Promise.all(this.starting);
    await Promise.all(this.ready.splice(0).map((sandbox) => sandbox.close()));
  }

  private fill(): void {
    if (this.closed) return;
    const starting = this.startOne().finally(() => this.starting.delete(starting));
    this.starting.add(starting);
  }

  private async startOne(): Promise<void> {
    let sandbox: Sandbox;
    try {
      sandbox = await Sandbox.start();
    } catch (error) {
      console.error("a sandbox failed to start:", error);
      if (this.closed) return;
      const retry = setTimeout(() => {
        this.retries.delete(retry);
        this.fill();
      }, RETRY_DELAY_MS);
      this.retries.add(retry);
      return;
    }
    this.started = true;
    if (this.closed) {
      await sandbox.close();
      return;
    }
    const waiter = this.waiting.shift();
    if (waiter) waiter(sandbox);
    else this.ready.push(sandbox);
  }

  private take(): Promise<Sandbox | null> {
    const ready = this.ready.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => {
      const give = (sandbox: Sandbox) => {
        clearTimeout(timer);
        resolve(sandbox);
      };
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter((waiter) => waiter !== give);
        resolve(null);
      }, this.waitSeconds * 1000);
      this.waiting.push(give);
    });
  }
}
