import { CompletionContext, CompletionProvider } from "./completion-provider";

export const COMPLETION_DEBOUNCE_MS = 300;
export const COMPLETION_TIMEOUT_MS = 15_000;

export interface CompletionClock {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: CompletionClock = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type CompletionOutcome =
  | { readonly status: "completed"; readonly text: string | null }
  | { readonly status: "cancelled" }
  | { readonly status: "failed" };

type Publish = (outcome: CompletionOutcome) => void;

interface RequestEntry {
  readonly generation: number;
  readonly controller: AbortController;
  debounceTimer?: unknown;
  timeoutTimer?: unknown;
  publish: Publish;
  settled: boolean;
}

/** Debounced, timeout-bounded requests, independently keyed by editor owner. */
export class CompletionController<Owner extends object = object> {
  private readonly requests = new Map<Owner, RequestEntry>();
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly provider: CompletionProvider,
    private readonly clock: CompletionClock = systemClock,
    private readonly debounceMs = COMPLETION_DEBOUNCE_MS,
    private readonly timeoutMs = COMPLETION_TIMEOUT_MS,
  ) {}

  schedule(owner: Owner, context: CompletionContext, publish: Publish): void {
    if (this.disposed) {
      this.publishSafely(publish, { status: "cancelled" });
      return;
    }
    this.cancel(owner);
    // Cancellation publishes synchronously, so its consumer may dispose this controller.
    if (this.disposed) {
      this.publishSafely(publish, { status: "cancelled" });
      return;
    }
    const entry: RequestEntry = {
      generation: ++this.generation,
      controller: new AbortController(),
      publish,
      settled: false,
    };
    this.requests.set(owner, entry);
    entry.debounceTimer = this.clock.setTimeout(() => {
      entry.debounceTimer = undefined;
      void this.execute(owner, entry, context);
    }, this.debounceMs);
  }

  cancel(owner: Owner): boolean {
    const entry = this.requests.get(owner);
    if (!entry) return false;
    this.finish(owner, entry, { status: "cancelled" });
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [owner, entry] of this.requests) {
      this.finish(owner, entry, { status: "cancelled" });
    }
  }

  private async execute(owner: Owner, entry: RequestEntry, context: CompletionContext): Promise<void> {
    if (!this.isCurrent(owner, entry)) return;
    entry.timeoutTimer = this.clock.setTimeout(() => {
      if (!this.isCurrent(owner, entry)) return;
      entry.controller.abort();
      this.finish(owner, entry, { status: "failed" });
    }, this.timeoutMs);
    try {
      const text = await this.provider.complete(context, entry.controller.signal);
      if (this.isCurrent(owner, entry)) this.finish(owner, entry, { status: "completed", text });
    } catch {
      if (this.isCurrent(owner, entry)) this.finish(owner, entry, { status: "failed" });
    }
  }

  private isCurrent(owner: Owner, entry: RequestEntry): boolean {
    return !this.disposed && !entry.settled && this.requests.get(owner) === entry && entry.generation <= this.generation;
  }

  private finish(owner: Owner, entry: RequestEntry, outcome: CompletionOutcome): void {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.debounceTimer !== undefined) this.clock.clearTimeout(entry.debounceTimer);
    if (entry.timeoutTimer !== undefined) this.clock.clearTimeout(entry.timeoutTimer);
    if (outcome.status === "cancelled") entry.controller.abort();
    if (this.requests.get(owner) === entry) this.requests.delete(owner);
    this.publishSafely(entry.publish, outcome);
  }

  private publishSafely(publish: Publish, outcome: CompletionOutcome): void {
    try {
      publish(outcome);
    } catch {
      // Consumer callbacks must not create unhandled request rejections.
    }
  }
}
