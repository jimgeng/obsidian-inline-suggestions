import { strict as assert } from "node:assert";
import { describe, it } from "mocha";
import { CompletionContext, CompletionProvider } from "../src/completion-provider";
import { CompletionClock, CompletionController } from "../src/completion-controller";

class FakeClock implements CompletionClock {
  private now = 0;
  private nextId = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();
  setTimeout(callback: () => void, delay: number): number {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.now + delay, callback });
    return id;
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
  tick(ms: number): void {
    const end = this.now + ms;
    while (true) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.now = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.now = end;
  }
  get pending(): number { return this.timers.size; }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const context: CompletionContext = { prefix: "prefix", suffix: "suffix" };
const owner = {};

class StubProvider implements CompletionProvider {
  calls: Array<{ context: CompletionContext; signal: AbortSignal; result: ReturnType<typeof deferred<string | null>> }> = [];
  complete(request: CompletionContext, signal: AbortSignal): Promise<string | null> {
    const result = deferred<string | null>();
    this.calls.push({ context: request, signal, result });
    return result.promise;
  }
}

describe("CompletionController", () => {
  it("debounces bursts and aborts superseded requests", () => {
    const clock = new FakeClock();
    const provider = new StubProvider();
    const controller = new CompletionController(provider, clock, 10, 50);
    const outcomes: string[] = [];
    controller.schedule(owner, context, result => outcomes.push(result.status));
    clock.tick(5);
    controller.schedule(owner, context, result => outcomes.push(result.status));
    clock.tick(9);
    assert.equal(provider.calls.length, 0);
    clock.tick(1);
    assert.equal(provider.calls.length, 1);
    controller.schedule(owner, context, result => outcomes.push(result.status));
    assert.equal(provider.calls[0].signal.aborted, true);
    assert.deepEqual(outcomes, ["cancelled", "cancelled"]);
    clock.tick(10);
    assert.equal(provider.calls.length, 2);
    provider.calls[0].result.resolve("stale");
    provider.calls[1].result.resolve("new");
    return Promise.resolve().then(() => assert.deepEqual(outcomes, ["cancelled", "cancelled", "completed"]));
  });

  it("ignores late resolution, converts rejection/timeout to failures, and cleans timers", async () => {
    const clock = new FakeClock();
    const provider = new StubProvider();
    const controller = new CompletionController(provider, clock, 1, 5);
    const outcomes: string[] = [];
    controller.schedule(owner, context, result => outcomes.push(result.status));
    clock.tick(1);
    clock.tick(5);
    assert.equal(provider.calls[0].signal.aborted, true);
    assert.deepEqual(outcomes, ["failed"]);
    provider.calls[0].result.resolve("late");
    await Promise.resolve();
    assert.deepEqual(outcomes, ["failed"]);
    assert.equal(clock.pending, 0);

    controller.schedule(owner, context, result => outcomes.push(result.status));
    clock.tick(1);
    provider.calls[1].result.reject(new Error("offline"));
    await Promise.resolve();
    assert.deepEqual(outcomes, ["failed", "failed"]);
    assert.equal(clock.pending, 0);
  });

  it("cancels during debounce and disposal prevents future publication", () => {
    const clock = new FakeClock();
    const provider = new StubProvider();
    const controller = new CompletionController(provider, clock);
    const outcomes: string[] = [];
    controller.schedule(owner, context, result => outcomes.push(result.status));
    controller.cancel(owner);
    clock.tick(1_000);
    assert.equal(provider.calls.length, 0);
    assert.deepEqual(outcomes, ["cancelled"]);
    controller.schedule(owner, context, result => outcomes.push(result.status));
    controller.dispose();
    controller.schedule(owner, context, result => outcomes.push(result.status));
    assert.equal(clock.pending, 0);
    assert.deepEqual(outcomes, ["cancelled", "cancelled", "cancelled"]);
  });

  it("does not register a request if supersession callback disposes the controller", () => {
    const clock = new FakeClock();
    const provider = new StubProvider();
    const controller = new CompletionController(provider, clock);
    const outcomes: string[] = [];
    controller.schedule(owner, context, outcome => {
      outcomes.push(`old:${outcome.status}`);
      if (outcome.status === "cancelled") controller.dispose();
    });

    controller.schedule(owner, context, outcome => outcomes.push(`new:${outcome.status}`));

    assert.deepEqual(outcomes, ["old:cancelled", "new:cancelled"]);
    assert.equal(clock.pending, 0);
    clock.tick(1_000);
    assert.equal(provider.calls.length, 0);
  });

  it("swallows callback errors when scheduling after disposal", () => {
    const clock = new FakeClock();
    const provider = new StubProvider();
    const controller = new CompletionController(provider, clock);
    controller.dispose();

    assert.doesNotThrow(() => controller.schedule(owner, context, () => {
      throw new Error("consumer error");
    }));
    assert.equal(clock.pending, 0);
    assert.equal(provider.calls.length, 0);
  });

  it("isolates requests by owner", () => {
    const clock = new FakeClock();
    const provider = new StubProvider();
    const controller = new CompletionController(provider, clock, 1, 100);
    const other = {};
    const outcomes: string[] = [];
    controller.schedule(owner, context, result => outcomes.push(`a:${result.status}`));
    controller.schedule(other, context, result => outcomes.push(`b:${result.status}`));
    clock.tick(1);
    controller.cancel(owner);
    assert.equal(provider.calls.length, 2);
    assert.equal(provider.calls[0].signal.aborted, true);
    provider.calls[1].result.resolve(null);
    return Promise.resolve().then(() => assert.deepEqual(outcomes, ["a:cancelled", "b:completed"]));
  });
});
