import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "mocha";
import { createMessageConnection, MessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import { CopilotAuth, CopilotStatus } from "../src/copilot/auth";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail("Timed out waiting for authentication event");
}
function fixture(resetSession: () => Promise<void> = async () => {}, openUrl?: (url: string) => Promise<void>) {
  const a = new PassThrough(), b = new PassThrough();
  const rpc = createMessageConnection(new StreamMessageReader(a), new StreamMessageWriter(b));
  const peer = createMessageConnection(new StreamMessageReader(b), new StreamMessageWriter(a));
  const statuses: (CopilotStatus | undefined)[] = [], notices: string[] = [], urls: string[] = [];
  const calls: { method: string; params?: unknown }[] = [];
  let ready = true;
  let modal: { code: string; proceed(): void; cancel(): void; closed: boolean } | undefined;
  const auth = new CopilotAuth({
    ready: () => ready,
    resetSession,
    status: status => statuses.push(status),
    notice: message => notices.push(message),
    openUrl: openUrl ?? (async url => { urls.push(url); }),
    showCode: (code, proceed, cancel) => {
      modal = { code, proceed, cancel, closed: false };
      const current = modal;
      return { close: () => { current.closed = true; cancel(); } };
    },
  });
  const detach = auth.attach(rpc);
  peer.onRequest("signIn", () => {
    calls.push({ method: "signIn" });
    return { userCode: "ABCD-EFGH", command: { command: "github.copilot.finishDeviceFlow", arguments: ["test"] } };
  });
  peer.onRequest("signOut", () => { calls.push({ method: "signOut" }); return {}; });
  peer.onRequest("workspace/executeCommand", params => { calls.push({ method: "workspace/executeCommand", params }); return {}; });
  rpc.listen(); peer.listen();
  cleanups.push(() => { detach(); rpc.dispose(); peer.dispose(); });
  return { auth, rpc, peer, statuses, notices, urls, calls, detach,
    get modal() { return modal; }, setReady(value: boolean) { ready = value; } };
}

describe("Copilot authentication (mock server, real JSON-RPC connection)", () => {
  it("shows the code before executing, opens the browser, and follows server status", async () => {
    const f = fixture();
    let release!: () => void;
    f.peer.onRequest("workspace/executeCommand", async params => {
      f.calls.push({ method: "workspace/executeCommand", params });
      assert.deepEqual(await f.peer.sendRequest("window/showDocument", { uri: "https://github.com/login/device", external: true }), { success: true });
      await new Promise<void>(resolve => { release = resolve; });
      await f.peer.sendNotification("didChangeStatus", { kind: "Normal", busy: false });
      return {};
    });
    await f.auth.signIn();
    assert.equal(f.modal?.code, "ABCD-EFGH");
    assert.deepEqual(f.calls.map(call => call.method), ["signIn"]);
    f.modal!.proceed(); f.modal!.proceed();
    await until(() => !!release);
    assert.deepEqual(f.calls[1].params, { command: "github.copilot.finishDeviceFlow", arguments: ["test"] });
    assert.deepEqual(f.urls, ["https://github.com/login/device"]);
    release();
    await until(() => f.modal!.closed && f.statuses.length === 1);
    assert.deepEqual(f.statuses, [{ kind: "Normal", busy: false }]);
    assert.deepEqual(f.notices, []);
  });
  it("closing the modal before proceeding never executes a command", async () => {
    const f = fixture();
    await f.auth.signIn();
    const modal = f.modal!;
    modal.cancel(); modal.proceed();
    assert.equal(modal.closed, true);
    assert.deepEqual(f.calls.map(call => call.method), ["signIn"]);
    await f.auth.signIn();
    assert.notEqual(f.modal, modal);
  });
  it("cancels a pending browser flow when the modal closes and ignores late success", async () => {
    const f = fixture();
    let cancelled = false, release!: () => void;
    f.peer.onRequest("workspace/executeCommand", async (_params, token) => {
      token.onCancellationRequested(() => { cancelled = true; });
      await new Promise<void>(resolve => { release = resolve; });
      return {};
    });
    await f.auth.signIn(); f.modal!.proceed();
    await until(() => !!release);
    f.modal!.cancel();
    await until(() => cancelled);
    assert.deepEqual(await f.peer.sendRequest("window/showDocument", { uri: "https://github.com/" }), { success: true });
    release();
    await f.auth.signIn();
    assert.equal(f.modal!.closed, false);
    assert.deepEqual(f.notices, []);
  });
  it("signs out, closing a pending modal without inventing a status", async () => {
    const f = fixture();
    await f.auth.signIn();
    await f.auth.signOut();
    assert.equal(f.modal!.closed, true);
    assert.equal(f.calls.at(-1)?.method, "signOut");
    assert.deepEqual(f.notices, ["Signed out of Copilot."]);
    assert.deepEqual(f.statuses, []);
  });
  it("handles all status kinds and busy independently; hints at most once", async () => {
    const f = fixture();
    for (const kind of ["Normal", "Error", "Warning", "Inactive"]) {
      for (const busy of [true, false]) {
        await f.peer.sendNotification("didChangeStatus", { kind, busy, message: "You are not signed into GitHub." });
      }
    }
    await f.peer.sendNotification("didChangeStatus", { kind: "Unknown" });
    await until(() => f.statuses.length === 8);
    assert.deepEqual(f.statuses, ["Normal", "Error", "Warning", "Inactive"].flatMap(kind => [
      { kind, busy: true, requiresSignIn: true }, { kind, busy: false, requiresSignIn: true },
    ]));
    assert.equal(f.notices.length, 1);
    assert.deepEqual(f.calls, []);
  });
  it("disposes a pending sign-in on disconnect and suppresses late UI", async () => {
    const f = fixture();
    let release!: (value: unknown) => void;
    f.peer.onRequest("signIn", () => new Promise(resolve => { release = resolve; }));
    const pending = f.auth.signIn();
    await until(() => !!release);
    f.detach();
    release({ userCode: "LATE", command: { command: "finish" } });
    await pending;
    assert.equal(f.modal, undefined);
    assert.deepEqual(f.notices, []);
    assert.deepEqual(f.statuses, [undefined]);
  });
  it("supports already signed in and handles errors without exposing server data", async () => {
    const f = fixture();
    f.peer.onRequest("signIn", () => ({ status: "AlreadySignedIn" }));
    await f.auth.signIn();
    assert.equal(f.modal, undefined);
    assert.equal(f.notices[0], "Copilot is already signed in.");
    f.peer.onRequest("signIn", () => { throw new Error("SECRET"); });
    await f.auth.signIn();
    f.peer.onRequest("signOut", () => { throw new Error("SECRET"); });
    await f.auth.signOut();
    assert.equal(f.notices.length, 3);
    assert.ok(f.notices.every(message => !message.includes("SECRET")));
  });
  it("rejects malformed sign-in responses and unsafe or unsolicited URLs", async () => {
    const f = fixture();
    f.peer.onRequest("signIn", () => ({ userCode: "CODE", command: { command: "finish", arguments: "wrong" } }));
    await f.auth.signIn();
    assert.equal(f.modal, undefined);
    assert.equal(f.notices.length, 1);
    for (const uri of ["https://github.com/", "file:///private", "javascript:alert(1)"]) {
      assert.deepEqual(await f.peer.sendRequest("window/showDocument", { uri }), { success: true });
    }
    assert.deepEqual(f.urls, []);
  });
  it("rejects non-web URLs even during an active sign-in", async () => {
    const f = fixture();
    let checked = false;
    f.peer.onRequest("workspace/executeCommand", async () => {
      for (const uri of ["file:///private", "javascript:alert(1)", "obsidian://open", "not a URL"]) {
        assert.deepEqual(await f.peer.sendRequest("window/showDocument", { uri }), { success: true });
      }
      checked = true;
      return {};
    });
    await f.auth.signIn(); f.modal!.proceed();
    await until(() => checked && f.modal!.closed);
    assert.deepEqual(f.urls, []);
  });
  it("closes a visible modal on disconnect and can attach to a replacement connection", async () => {
    const f = fixture(), replacement = fixture();
    await f.auth.signIn();
    f.detach();
    assert.equal(f.modal!.closed, true);
    const detach = f.auth.attach(replacement.rpc);
    cleanups.push(detach);
    await f.auth.signIn();
    assert.equal(f.modal!.closed, false);
    assert.equal(replacement.calls.at(-1)?.method, "signIn");
  });
  it("retires cancellation-ignoring device polling before sign-out can complete", async () => {
    let terminate!: () => void;
    let processAlive = true, signedIn = false, retired = false, completed = false;
    const f = fixture(async () => {
      await new Promise<void>(resolve => { terminate = resolve; });
      processAlive = false;
      retired = true;
    });
    let authorize!: () => void;
    f.peer.onRequest("workspace/executeCommand", async () => {
      // Model the official server's polling: deliberately ignore RPC cancellation.
      await new Promise<void>(resolve => { authorize = resolve; });
      if (processAlive) signedIn = true;
      completed = true;
      return {};
    });
    f.peer.onRequest("signOut", () => {
      assert.equal(retired, true);
      f.calls.push({ method: "signOut" });
      signedIn = false;
      return {};
    });
    await f.auth.signIn(); f.modal!.proceed();
    await until(() => !!authorize);
    const signingOut = f.auth.signOut();
    await until(() => !!terminate);
    assert.equal(f.modal!.closed, true);
    assert.ok(!f.calls.some(call => call.method === "signOut"));
    terminate();
    await signingOut;
    authorize();
    await until(() => completed);
    assert.equal(signedIn, false);
    assert.deepEqual(f.notices, ["Signed out of Copilot."]);
  });
  it("reports browser launch failures and retires the pending flow", async () => {
    let resets = 0, handled = false;
    const f = fixture(async () => { resets++; }, async () => { throw new Error("SECRET"); });
    f.peer.onRequest("workspace/executeCommand", async () => {
      assert.deepEqual(await f.peer.sendRequest("window/showDocument", { uri: "https://github.com/login/device" }), { success: true });
      handled = true;
      return {};
    });
    await f.auth.signIn(); f.modal!.proceed();
    await until(() => handled && resets === 1);
    assert.equal(f.modal!.closed, true);
    assert.deepEqual(f.notices, ["Could not open the Copilot sign-in page. Please try signing in again."]);
  });
  it("retires polling even when cancelled before opening the browser", async () => {
    let resets = 0;
    const f = fixture(async () => { resets++; });
    await f.auth.signIn();
    f.modal!.cancel();
    await f.auth.signIn();
    assert.equal(resets, 1);
    assert.equal(f.modal!.closed, false);
  });
  it("sign-out supersedes a sign-in command still waiting for readiness", async () => {
    const f = fixture();
    await Promise.all([f.auth.signIn(), f.auth.signOut()]);
    assert.deepEqual(f.calls.map(call => call.method), ["signOut"]);
    assert.equal(f.modal, undefined);
  });
  it("does not send commands until the server is ready", async () => {
    const f = fixture(); f.setReady(false);
    await f.auth.signIn(); await f.auth.signOut();
    assert.deepEqual(f.calls, []);
    assert.equal(f.notices.length, 2);
  });
  it("tracks authentication independently from temporary server health", async () => {
    const f = fixture();
    assert.equal(f.auth.state.authentication, "unknown");
    await f.peer.sendNotification("didChangeStatus", { kind: "Normal", busy: false });
    await until(() => f.auth.state.authentication === "signed-in");
    for (const kind of ["Warning", "Inactive", "Error"]) {
      await f.peer.sendNotification("didChangeStatus", { kind, busy: false, message: "Temporary service problem" });
      await until(() => f.auth.state.status?.kind === kind);
      assert.equal(f.auth.state.authentication, "signed-in");
    }
    await f.peer.sendNotification("didChangeStatus", { kind: "Error", busy: false, message: "You are not signed into GitHub." });
    await until(() => f.auth.state.authentication === "signed-out");
    await f.peer.sendNotification("didChangeStatus", { kind: "Warning", busy: true });
    await until(() => f.auth.state.status?.kind === "Warning");
    assert.equal(f.auth.state.authentication, "signed-out");
    f.detach();
    assert.equal(f.auth.state.authentication, "unknown");
    assert.equal(f.auth.state.available, false);
  });
  it("publishes pending and completed authentication state to subscribed controls", async () => {
    const f = fixture();
    const states: typeof f.auth.state[] = [];
    const unsubscribe = f.auth.subscribe(state => states.push(state));
    await f.auth.signIn();
    assert.equal(f.auth.state.pending, true);
    assert.equal(f.auth.state.authentication, "signed-out");
    await f.auth.signOut();
    assert.equal(f.auth.state.pending, false);
    assert.equal(f.auth.state.authentication, "signed-out");
    assert.ok(states.some(state => state.pending));
    f.peer.onRequest("signIn", () => ({ status: "AlreadySignedIn" }));
    await f.auth.signIn();
    assert.equal(f.auth.state.authentication, "signed-in");
    assert.equal(f.auth.state.pending, false);
    const count = states.length;
    unsubscribe();
    f.auth.connectionChanged();
    assert.equal(states.length, count);
  });
  it("does not infer signed-out status from a generic server error", async () => {
    const f = fixture();
    await f.peer.sendNotification("didChangeStatus", { kind: "Error", busy: false, message: "Quota exceeded" });
    await until(() => !!f.auth.state.status);
    assert.equal(f.auth.state.authentication, "unknown");
    await f.peer.sendNotification("didChangeStatus", { kind: "Error", busy: false, command: { command: "github.copilot.signIn" } });
    await until(() => f.auth.state.authentication === "signed-out");
  });
  it("classifies explicit sign-in hints without retaining server text or command arguments", async () => {
    const f = fixture();
    for (const hint of [
      { message: "You are not signed into GitHub." },
      { message: "You are not signed in." },
      { message: "Signed out" },
      { message: "Please sign in again" },
      { command: { command: "github.copilot.signIn", arguments: ["PRIVATE"] } },
    ]) {
      const count = f.statuses.length;
      await f.peer.sendNotification("didChangeStatus", { kind: "Error", busy: false, ...hint });
      await until(() => f.statuses.length > count);
      assert.equal(f.auth.state.authentication, "signed-out");
      assert.deepEqual(f.auth.state.status, { kind: "Error", busy: false, requiresSignIn: true });
    }
    for (const kind of ["Error", "Warning", "Inactive"]) {
      const count = f.statuses.length;
      await f.peer.sendNotification("didChangeStatus", { kind, busy: true, message: "Quota exceeded" });
      await until(() => f.statuses.length > count);
      assert.deepEqual(f.auth.state.status, { kind, busy: true });
      assert.equal(f.auth.state.authentication, "signed-out");
    }
    await f.peer.sendNotification("didChangeStatus", { kind: "Normal", busy: false });
    await until(() => f.auth.state.authentication === "signed-in");
    assert.deepEqual(f.auth.state.status, { kind: "Normal", busy: false });
    // Successful sign-out must not let the previous Normal status imply readiness.
    await f.auth.signOut();
    assert.equal(f.auth.state.authentication, "signed-out");
    assert.equal(f.auth.state.status?.kind, "Normal");
    f.detach();
    assert.equal(f.auth.state.status, undefined);
    assert.equal(f.auth.state.authentication, "unknown");
  });

  it("coalesces repeated sign-in commands", async () => {
    const f = fixture();
    await Promise.all([f.auth.signIn(), f.auth.signIn()]);
    await f.auth.signIn();
    assert.deepEqual(f.calls.map(call => call.method), ["signIn"]);
  });
});
