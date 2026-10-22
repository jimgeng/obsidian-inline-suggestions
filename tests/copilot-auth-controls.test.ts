import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { describe, it } from "mocha";
import type { AuthState } from "../src/copilot/auth";
import { bindAuthSettings, bindAuthStatusBar } from "../src/copilot/auth-controls";

function fixture(initial: Partial<AuthState> = {}) {
  const dom = new JSDOM("<div id='bar'></div><div id='settings'></div>");
  let state: AuthState = { authentication: "unknown", pending: false, available: true, ...initial };
  const listeners = new Set<(state: AuthState) => void>();
  const calls: string[] = [];
  const auth = {
    get state() { return state; },
    subscribe(listener: (state: AuthState) => void) {
      listeners.add(listener); listener(state);
      return () => { listeners.delete(listener); };
    },
    async signIn() { calls.push("signIn"); },
    async signOut() { calls.push("signOut"); },
  };
  return {
    dom, auth, calls, listeners,
    bar: dom.window.document.getElementById("bar")!,
    settings: dom.window.document.getElementById("settings")!,
    update(patch: Partial<AuthState>) { state = { ...state, ...patch }; for (const listener of listeners) listener(state); },
  };
}

describe("Copilot authentication controls", () => {
  it("offers mouse and keyboard sign-in from the signed-out status bar", () => {
    const f = fixture({ authentication: "signed-out", status: { kind: "Error", busy: false } });
    const dispose = bindAuthStatusBar(f.bar, f.auth);
    assert.equal(f.bar.textContent, "Copilot: signed out");
    assert.equal(f.bar.getAttribute("role"), "button");
    assert.equal(f.bar.tabIndex, 0);
    assert.match(f.bar.title, /Click to sign in/);
    f.bar.click();
    f.bar.dispatchEvent(new f.dom.window.KeyboardEvent("keydown", { key: "Enter" }));
    f.bar.dispatchEvent(new f.dom.window.KeyboardEvent("keydown", { key: " " }));
    assert.deepEqual(f.calls, ["signIn", "signIn", "signIn"]);
    dispose(); f.dom.window.close();
  });

  it("does not launch sign-in when signed in, unknown, unavailable or pending", () => {
    const f = fixture({ authentication: "signed-in", status: { kind: "Warning", busy: true } });
    const dispose = bindAuthStatusBar(f.bar, f.auth);
    assert.equal(f.bar.textContent, "Copilot: warning (busy)");
    for (const patch of [
      { authentication: "signed-in" as const },
      { authentication: "unknown" as const },
      { authentication: "signed-out" as const, pending: true },
      { pending: false, available: false },
    ]) {
      f.update(patch); f.bar.click();
      f.bar.dispatchEvent(new f.dom.window.KeyboardEvent("keydown", { key: "Enter" }));
      assert.equal(f.bar.hasAttribute("role"), false);
      assert.equal(f.bar.hasAttribute("tabindex"), false);
    }
    assert.deepEqual(f.calls, []);
    dispose(); f.dom.window.close();
  });

  it("keeps settings and the status bar synchronized with relevant actions", () => {
    const f = fixture({ authentication: "signed-out", status: { kind: "Error", busy: false } });
    const disposeBar = bindAuthStatusBar(f.bar, f.auth);
    const disposeSettings = bindAuthSettings(f.settings, f.auth);
    assert.equal(f.settings.querySelector("h2")?.textContent, "Copilot authentication");
    const [signIn, signOut] = Array.from(f.settings.querySelectorAll("button"));
    const status = f.settings.querySelector("[role=status]")!;
    assert.match(status.textContent!, /Signed out — error/);
    assert.equal(signIn.hidden, false); assert.equal(signOut.hidden, true);
    signIn.click();
    assert.deepEqual(f.calls, ["signIn"]);
    f.update({ pending: true });
    assert.equal(signIn.disabled, true);
    assert.match(status.textContent!, /authentication in progress/);
    signIn.click(); f.bar.click();
    assert.deepEqual(f.calls, ["signIn"]);
    f.update({ authentication: "signed-in", pending: false, status: { kind: "Normal", busy: false } });
    assert.match(status.textContent!, /Signed in — normal/);
    assert.equal(f.bar.textContent, "Copilot: normal");
    assert.equal(signIn.hidden, true); assert.equal(signOut.hidden, false);
    signOut.click();
    assert.deepEqual(f.calls, ["signIn", "signOut"]);
    f.update({ status: { kind: "Warning", busy: true } });
    assert.equal(signOut.hidden, false);
    assert.match(status.textContent!, /Signed in — warning \(busy\)/);
    disposeBar(); disposeSettings(); f.dom.window.close();
  });

  it("allows either explicit action when authentication is unknown but disables both offline", () => {
    const f = fixture({ status: { kind: "Error", busy: false } });
    const dispose = bindAuthSettings(f.settings, f.auth);
    const buttons = Array.from(f.settings.querySelectorAll("button"));
    assert.match(f.settings.textContent!, /Authentication status unknown — error/);
    assert.ok(buttons.every(button => !button.hidden && !button.disabled));
    f.update({ available: false });
    assert.match(f.settings.textContent!, /unavailable or starting/);
    assert.ok(buttons.every(button => button.disabled));
    for (const button of buttons) button.click();
    assert.deepEqual(f.calls, []);
    dispose(); f.dom.window.close();
  });

  it("disposes subscriptions and event handlers when hidden or unloaded", () => {
    const f = fixture({ authentication: "signed-out" });
    const disposeBar = bindAuthStatusBar(f.bar, f.auth);
    const disposeSettings = bindAuthSettings(f.settings, f.auth);
    const signIn = f.settings.querySelector("button")!;
    assert.equal(f.listeners.size, 2);
    disposeBar(); disposeSettings();
    assert.equal(f.listeners.size, 0);
    assert.equal(f.settings.children.length, 0);
    const oldText = f.bar.textContent;
    f.update({ authentication: "signed-in" });
    assert.equal(f.bar.textContent, oldText);
    f.bar.click(); signIn.click();
    assert.deepEqual(f.calls, []);
    // Reopening settings creates a single fresh section reflecting the latest state.
    const disposeAgain = bindAuthSettings(f.settings, f.auth);
    assert.equal(f.listeners.size, 1);
    assert.match(f.settings.textContent!, /Signed in/);
    disposeAgain(); f.dom.window.close();
  });
});
