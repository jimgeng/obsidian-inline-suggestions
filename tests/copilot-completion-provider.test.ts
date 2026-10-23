import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "mocha";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, ResponseError } from "vscode-jsonrpc/node";
import { CopilotCompletionProvider } from "../src/copilot/completion-provider";
import { CopilotAuth } from "../src/copilot/auth";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail("Timed out waiting for protocol event");
}
function fixture() {
  const a = new PassThrough(), b = new PassThrough();
  const rpc = createMessageConnection(new StreamMessageReader(a), new StreamMessageWriter(b));
  const peer = createMessageConnection(new StreamMessageReader(b), new StreamMessageWriter(a));
  const calls: { method: string; params: any }[] = [];
  peer.onNotification((method, params) => { calls.push({ method, params }); });
  peer.onRequest("textDocument/inlineCompletion", params => {
    calls.push({ method: "textDocument/inlineCompletion", params });
    return { items: [{ insertText: "next", range: { start: params.position, end: params.position } }] };
  });
  let ready = true;
  let formatting = { tabSize: 4, insertSpaces: false };
  const provider = new CopilotCompletionProvider(() => ready ? rpc : undefined, () => formatting);
  rpc.listen(); peer.listen();
  cleanups.push(() => { rpc.dispose(); peer.dispose(); });
  return { rpc, peer, provider, calls, setReady(value: boolean) { ready = value; }, setFormatting(value: typeof formatting) { formatting = value; } };
}
const signal = () => new AbortController().signal;

describe("Copilot completion provider (real JSON-RPC, mock server)", () => {
  it("gates context on real auth state without suppressing document cleanup", async () => {
    const f = fixture();
    let ready = true;
    const auth = new CopilotAuth({ ready: () => ready, resetSession: async () => {},
      notice: () => {}, openUrl: async () => {}, showCode: () => ({ close() {} }) });
    cleanups.push(auth.attach(f.rpc));
    f.peer.onRequest("signOut", () => ({}));
    const provider = new CopilotCompletionProvider(() => f.rpc, () => ({ tabSize: 4, insertSpaces: true }), () => auth.canComplete);
    const context = { prefix: "private note", suffix: "" };
    const blocked = async () => {
      const before = f.calls.length;
      await provider.sync(context); await provider.focus();
      assert.equal(await provider.complete(context, signal()), null);
      await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(f.calls.length, before);
    };
    await blocked(); // Unknown credentials on startup.
    await f.peer.sendNotification("didChangeStatus", { kind: "Normal" });
    await until(() => auth.canComplete);
    assert.equal(await provider.complete(context, signal()), "next");
    ready = false; await blocked(); ready = true;
    await f.peer.sendNotification("didChangeStatus", { kind: "Error" });
    await until(() => !auth.canComplete); await blocked();
    await f.peer.sendNotification("didChangeStatus", { kind: "Normal" });
    await until(() => auth.canComplete);
    await auth.signOut(); await blocked();
    await provider.close();
    await until(() => f.calls.some(call => call.method === "textDocument/didClose"));
    assert.equal(f.calls.filter(call => call.method === "textDocument/didOpen").length, 1);
    assert.equal(f.calls.filter(call => call.method === "textDocument/inlineCompletion").length, 1);
  });

  it("rechecks permission before queued sync sends any context", async () => {
    const f = fixture();
    let enabled = true;
    const provider = new CopilotCompletionProvider(() => f.rpc, () => ({ tabSize: 4, insertSpaces: true }), () => enabled);
    const pending = provider.complete({ prefix: "not sent", suffix: "" }, signal());
    enabled = false;
    assert.equal(await pending, null);
    assert.deepEqual(f.calls, []);
    await provider.close();
  });

  it("opens, focuses, versions incremental changes, sends formatting, and closes", async () => {
    const f = fixture();
    assert.equal(await f.provider.complete({ prefix: "a", suffix: "" }, signal()), "next");
    assert.deepEqual(f.calls.map(c => c.method), ["textDocument/didOpen", "textDocument/didFocus", "textDocument/inlineCompletion"]);
    const uri = f.calls[0]!.params.textDocument.uri;
    assert.deepEqual(f.calls[0]!.params, { textDocument: { uri, languageId: "markdown", version: 1, text: "a" } });
    f.setFormatting({ tabSize: 2, insertSpaces: true });
    await f.provider.complete({ prefix: "abc", suffix: "" }, signal());
    assert.deepEqual(f.calls[3]!.params, { textDocument: { uri, version: 2 }, contentChanges: [{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, text: "bc" }] });
    assert.deepEqual(f.calls[5]!.params, { textDocument: { uri, version: 2 }, position: { line: 0, character: 3 }, context: { triggerKind: 2 }, formattingOptions: { tabSize: 2, insertSpaces: true } });
    await f.provider.complete({ prefix: "ab", suffix: "c" }, signal());
    assert.equal(f.calls.filter(c => c.method === "textDocument/didChange").length, 1);
    await f.provider.close();
    await until(() => f.calls.some(c => c.method === "textDocument/didClose"));
    assert.equal(await f.provider.complete({ prefix: "", suffix: "" }, signal()), null);
  });
  it("sends cancellation and promptly ignores a late server response", async () => {
    const f = fixture();
    let release!: (response: unknown) => void;
    let cancelled = false;
    f.peer.onRequest("textDocument/inlineCompletion", (_params, token) => {
      token.onCancellationRequested(() => { cancelled = true; });
      return new Promise(resolve => { release = resolve; });
    });
    const controller = new AbortController();
    const result = f.provider.complete({ prefix: "", suffix: "" }, controller.signal);
    await until(() => !!release);
    controller.abort();
    assert.equal(await result, null);
    await until(() => cancelled); // vscode-jsonrpc maps token cancellation to $/cancelRequest.
    release({ items: [{ insertText: "late", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }] });
    f.peer.onRequest("textDocument/inlineCompletion", () => ({ items: [] }));
    assert.equal(await f.provider.complete({ prefix: "", suffix: "" }, signal()), null);
  });
  it("skips pre-aborted requests and unavailable servers", async () => {
    const f = fixture();
    const controller = new AbortController(); controller.abort();
    assert.equal(await f.provider.complete({ prefix: "", suffix: "" }, controller.signal), null);
    f.setReady(false);
    assert.equal(await f.provider.complete({ prefix: "", suffix: "" }, signal()), null);
    assert.deepEqual(f.calls, []);
    f.setReady(true);
    assert.equal(await f.provider.complete({ prefix: "", suffix: "" }, signal()), "next");
  });
  it("treats ServerCancelled and other errors as null, then recovers", async () => {
    const f = fixture();
    for (const code of [-32802, -32603]) {
      f.peer.onRequest("textDocument/inlineCompletion", () => { throw new ResponseError(code, "server error"); });
      assert.equal(await f.provider.complete({ prefix: "", suffix: "" }, signal()), null);
    }
    for (const response of [null, {}, { items: [null] }, JSON.parse(readFileSync("tests/fixtures/copilot/empty-items.json", "utf8")).response]) {
      f.peer.onRequest("textDocument/inlineCompletion", () => response);
      assert.equal(await f.provider.complete({ prefix: "", suffix: "" }, signal()), null);
    }
  });
  it("isolates editor URIs and closes pending requests", async () => {
    const f = fixture();
    const second = new CopilotCompletionProvider(() => f.rpc, () => ({ tabSize: 2, insertSpaces: true }));
    await f.provider.complete({ prefix: "one", suffix: "" }, signal());
    await second.complete({ prefix: "two", suffix: "" }, signal());
    const opens = f.calls.filter(c => c.method === "textDocument/didOpen");
    assert.notEqual(opens[0]!.params.textDocument.uri, opens[1]!.params.textDocument.uri);
    let started = false, cancelled = false;
    let release!: () => void;
    f.peer.onRequest("textDocument/inlineCompletion", (_params, token) => {
      started = true;
      token.onCancellationRequested(() => { cancelled = true; });
      return new Promise(resolve => { release = () => resolve(null); });
    });
    const result = second.complete({ prefix: "two", suffix: "" }, signal());
    await until(() => started);
    await second.close();
    assert.equal(await result, null);
    await until(() => cancelled);
    release();
  });
  it("rejects a context superseded by sync before request dispatch", async () => {
    const f = fixture();
    const result = f.provider.complete({ prefix: "old", suffix: "" }, signal());
    await f.provider.sync({ prefix: "new document", suffix: "" });
    assert.equal(await result, null);
    assert.equal(f.calls.some(c => c.method === "textDocument/inlineCompletion"), false);
  });
  it("does not let pre-aborted calls cancel valid work, but supersession does", async () => {
    const f = fixture();
    const pending: { release(value: unknown): void; cancelled: boolean }[] = [];
    f.peer.onRequest("textDocument/inlineCompletion", (_params, token) => {
      const entry = { release: (_value: unknown) => {}, cancelled: false };
      token.onCancellationRequested(() => { entry.cancelled = true; });
      return new Promise(resolve => { entry.release = resolve; pending.push(entry); });
    });
    const first = f.provider.complete({ prefix: "old", suffix: "" }, signal());
    await until(() => pending.length === 1);
    const aborted = new AbortController(); aborted.abort();
    assert.equal(await f.provider.complete({ prefix: "ignored", suffix: "" }, aborted.signal), null);
    assert.equal(pending[0]!.cancelled, false);
    const second = f.provider.complete({ prefix: "new", suffix: "" }, signal());
    assert.equal(await first, null);
    await until(() => pending.length === 2 && pending[0]!.cancelled);
    pending[0]!.release({ items: [] });
    pending[1]!.release({ items: [{ insertText: " valid", range: { start: { line: 0, character: 3 }, end: { line: 0, character: 3 } } }] });
    assert.equal(await second, " valid");
  });
  it("reopens the document at version one after a connection replacement", async () => {
    const first = fixture(), second = fixture();
    let connection = first.rpc;
    const provider = new CopilotCompletionProvider(() => connection, () => ({ tabSize: 2, insertSpaces: true }));
    await provider.complete({ prefix: "a", suffix: "" }, signal());
    await provider.complete({ prefix: "ab", suffix: "" }, signal());
    connection = second.rpc;
    await provider.complete({ prefix: "abc", suffix: "" }, signal());
    assert.equal(second.calls[0]!.method, "textDocument/didOpen");
    assert.equal(second.calls[0]!.params.textDocument.version, 1);
    assert.equal(second.calls[0]!.params.textDocument.text, "abc");
    await provider.close();
  });
  it("invalidates a completion as soon as a newer sync starts, even when its write blocks", async () => {
    const f = fixture();
    let respond!: (value: unknown) => void;
    f.peer.onRequest("textDocument/inlineCompletion", () => new Promise(resolve => { respond = resolve; }));
    const pending = f.provider.complete({ prefix: "a", suffix: "" }, signal());
    await until(() => !!respond);
    const original = f.rpc.sendNotification.bind(f.rpc);
    let release!: () => void;
    f.rpc.sendNotification = ((method: string, ...args: unknown[]) => method === "textDocument/didChange"
      ? new Promise<void>(resolve => { release = resolve; }) : (original as any)(method, ...args)) as typeof f.rpc.sendNotification;
    const sync = f.provider.sync({ prefix: "b", suffix: "" });
    await until(() => !!release);
    respond({ items: [{ insertText: "stale", range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } } }] });
    assert.equal(await pending, null);
    release(); await sync;
    await f.provider.close();
  });

  it("ignores a response after an independent document change", async () => {
    const f = fixture();
    let release!: (value: unknown) => void;
    f.peer.onRequest("textDocument/inlineCompletion", () => new Promise(resolve => { release = resolve; }));
    const result = f.provider.complete({ prefix: "a", suffix: "" }, signal());
    await until(() => !!release);
    await f.provider.sync({ prefix: "b", suffix: "" });
    release({ items: [{ insertText: "stale", range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } } }] });
    assert.equal(await result, null);
  });
  for (const method of ["textDocument/didOpen", "textDocument/didChange", "textDocument/didFocus", "textDocument/didClose"]) {
    it(`retires a blocked ${method} write and recovers only on a replacement connection`, async () => {
      const first = fixture(), second = fixture();
      let connection = first.rpc;
      let stalled = 0;
      const provider = new CopilotCompletionProvider(() => connection, () => ({ tabSize: 2, insertSpaces: true }),
        () => true, { writeTimeoutMs: 20, onStalled: rpc => { assert.equal(rpc, first.rpc); stalled++; } });
      if (method !== "textDocument/didOpen") await provider.complete({ prefix: "a", suffix: "" }, signal());
      const original = first.rpc.sendNotification.bind(first.rpc);
      let release!: () => void;
      first.rpc.sendNotification = ((name: string, ...args: unknown[]) => name === method
        ? new Promise<void>(resolve => { release = resolve; }) : (original as any)(name, ...args)) as typeof first.rpc.sendNotification;
      if (method === "textDocument/didClose") await provider.close();
      else assert.equal(await provider.complete({ prefix: "ab", suffix: "" }, signal()), null);
      assert.equal(stalled, 1);
      assert.equal(await provider.complete({ prefix: "not sent", suffix: "" }, signal()), null);
      connection = second.rpc;
      if (method !== "textDocument/didClose") {
        assert.equal(await provider.complete({ prefix: "replacement", suffix: "" }, signal()), "next");
        assert.equal(second.calls[0]!.params.textDocument.version, 1);
        release(); // A late write must not overwrite the replacement session's document.
        await provider.complete({ prefix: "replacement!", suffix: "" }, signal());
        assert.equal(second.calls.find(call => call.method === "textDocument/didChange")!.params.textDocument.version, 2);
      } else release();
      await provider.close();
    });
  }

  it("bypasses a blocked old connection immediately and skips superseded queued context", async () => {
    const first = fixture(), second = fixture();
    let connection = first.rpc;
    const provider = new CopilotCompletionProvider(() => connection, () => ({ tabSize: 2, insertSpaces: true }));
    const original = first.rpc.sendNotification.bind(first.rpc);
    let release!: () => void;
    first.rpc.sendNotification = ((method: string, ...args: unknown[]) => method === "textDocument/didOpen"
      ? new Promise<void>(resolve => { release = resolve; }) : (original as any)(method, ...args)) as typeof first.rpc.sendNotification;
    const old = provider.complete({ prefix: "old", suffix: "" }, signal());
    await until(() => !!release);
    const superseded = provider.complete({ prefix: "must not send", suffix: "" }, signal());
    const latest = provider.complete({ prefix: "latest", suffix: "" }, signal());
    connection = second.rpc;
    assert.equal(await provider.complete({ prefix: "new connection", suffix: "" }, signal()), "next");
    assert.deepEqual(await Promise.all([old, superseded, latest]), [null, null, null]);
    release();
    await provider.close();
    assert.equal(first.calls.some(call => call.params?.textDocument?.text === "must not send"), false);
    assert.equal(second.calls[0]!.params.textDocument.text, "new connection");
  });

  it("preserves write order while dropping stale work behind a blocked write", async () => {
    const f = fixture();
    const original = f.rpc.sendNotification.bind(f.rpc);
    let release!: () => void;
    f.rpc.sendNotification = ((method: string, ...args: unknown[]) => method === "textDocument/didOpen"
      ? new Promise<void>(resolve => { release = () => { void (original as any)(method, ...args).then(resolve); }; })
      : (original as any)(method, ...args)) as typeof f.rpc.sendNotification;
    const first = f.provider.complete({ prefix: "first", suffix: "" }, signal());
    await until(() => !!release);
    const stale = f.provider.complete({ prefix: "stale", suffix: "" }, signal());
    const latest = f.provider.complete({ prefix: "latest", suffix: "" }, signal());
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.calls.length, 0);
    release();
    assert.deepEqual(await Promise.all([first, stale, latest]), [null, null, "next"]);
    const changes = f.calls.filter(call => call.method === "textDocument/didChange");
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.params.textDocument.version, 2);
    // The unchanged suffix "st" is retained by the incremental replacement.
    assert.equal(changes[0]!.params.contentChanges[0].text, "late");
    await f.provider.close();
  });

  it("skips cancelled queued document context without retiring a healthy connection", async () => {
    const f = fixture();
    const pending = f.provider.complete({ prefix: "cancelled", suffix: "" }, signal());
    const latest = f.provider.complete({ prefix: "latest", suffix: "" }, signal());
    assert.equal(await pending, null);
    assert.equal(await latest, "next");
    assert.equal(f.calls.filter(call => call.method === "textDocument/didOpen").length, 1);
    assert.equal(f.calls[0]!.params.textDocument.text, "latest");
    await f.provider.close();
  });

  it("normalizes document newlines and avoids splitting changed surrogate pairs", async () => {
    const f = fixture();
    await f.provider.complete({ prefix: "a\r\n😀", suffix: "" }, signal());
    await f.provider.complete({ prefix: "a\r\n😁", suffix: "" }, signal());
    const change = f.calls.find(c => c.method === "textDocument/didChange")!.params.contentChanges[0];
    assert.deepEqual(change, { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } }, text: "😁" });
  });
});
