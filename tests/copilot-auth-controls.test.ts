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
    const f = fixture({ authentication: "signed-out", status: { kind: "Error", busy: false, requiresSignIn: true } });
    const disposeBar = bindAuthStatusBar(f.bar, f.auth);
    const disposeSettings = bindAuthSettings(f.settings, f.auth);
    assert.equal(f.settings.querySelector("h2")?.textContent, "Copilot authentication");
    const signIn = f.settings.querySelector("button")!;
    const status = f.settings.querySelector("[role=status]")!;
    assert.equal(status.textContent, "Signed out. Sign in to use Copilot.");
    assert.deepEqual(Array.from(f.settings.querySelectorAll("button"), button => button.textContent), ["Sign in"]);
    signIn.click();
    assert.deepEqual(f.calls, ["signIn"]);
    f.update({ pending: true });
    assert.equal(signIn.disabled, true);
    assert.match(status.textContent!, /Authentication in progress/);
    signIn.click(); f.bar.click();
    assert.deepEqual(f.calls, ["signIn"]);
    f.update({ authentication: "signed-in", pending: false, status: { kind: "Normal", busy: false } });
    assert.equal(status.textContent, "Signed in — Ready");
    assert.equal(f.bar.textContent, "Copilot: normal");
    assert.equal(signIn.isConnected, false);
    const signOut = f.settings.querySelector("button")!;
    assert.deepEqual(Array.from(f.settings.querySelectorAll("button"), button => button.textContent), ["Sign out"]);
    signOut.click();
    assert.deepEqual(f.calls, ["signIn", "signOut"]);
    f.update({ status: { kind: "Warning", busy: true } });
    assert.equal(f.settings.querySelector("button"), signOut);
    assert.equal(status.textContent, "Signed in — Temporary service issue — Copilot is busy");
    disposeBar(); disposeSettings(); f.dom.window.close();
  });

  it("attaches only the relevant action despite host CSS, and disables it offline or pending", () => {
    const f = fixture({ status: { kind: "Error", busy: false } });
    const style = f.dom.window.document.createElement("style");
    style.textContent = "button { display: inline-flex; }";
    f.dom.window.document.head.append(style);
    const dispose = bindAuthSettings(f.settings, f.auth);
    const labels = () => Array.from(f.settings.querySelectorAll("button"), button => button.textContent);
    assert.match(f.settings.textContent!, /Authentication status unknown — Copilot access problem/);
    assert.deepEqual(labels(), []);
    for (const authentication of ["signed-out", "signed-in", "unknown", "signed-in", "signed-out"] as const) {
      f.update({ authentication, available: true, pending: false });
      assert.deepEqual(labels(), authentication === "unknown" ? []
        : [authentication === "signed-out" ? "Sign in" : "Sign out"]);
      const button = f.settings.querySelector("button");
      if (!button) continue;
      assert.equal(button.disabled, false);
      assert.equal(f.dom.window.getComputedStyle(button).display, "inline-flex");
      button.focus();
      f.update({ status: { kind: "Warning", busy: true } });
      assert.equal(f.dom.window.document.activeElement, button);
      for (const patch of [{ pending: true }, { pending: false, available: false }]) {
        f.update(patch);
        assert.equal(f.settings.querySelector("button"), button);
        assert.equal(button.disabled, true);
        button.click();
      }
      assert.match(f.settings.textContent!, /unavailable or starting/);
    }
    f.update({ authentication: "unknown" });
    assert.deepEqual(labels(), []);
    assert.deepEqual(f.calls, []);
    dispose(); f.dom.window.close();
  });

  it("distinguishes server health from authentication and activity", () => {
    const f = fixture({ authentication: "signed-out" });
    const dispose = bindAuthSettings(f.settings, f.auth);
    const status = f.settings.querySelector("[role=status]")!;
    for (const authentication of ["signed-out", "signed-in", "unknown"] as const) {
      f.update({ authentication, status: { kind: "Error", busy: false, requiresSignIn: true } });
      assert.doesNotMatch(status.textContent!, /error|problem/i);
      f.update({ status: { kind: "Error", busy: false } });
      assert.match(status.textContent!, /Copilot access problem/);
      f.update({ status: { kind: "Warning", busy: false } });
      assert.match(status.textContent!, /Temporary service issue/);
      f.update({ status: { kind: "Inactive", busy: true } });
      assert.match(status.textContent!, /Suggestions unavailable for this file \(size or content exclusions\) — Copilot is busy/);
      f.update({ status: { kind: "Normal", busy: false } });
      assert.equal(status.textContent!.includes("Ready"), authentication === "signed-in");
      assert.doesNotMatch(status.textContent!, /busy|problem|Temporary|exclusions/);
    }
    f.update({ status: undefined, available: false, pending: true });
    assert.match(status.textContent!, /unavailable or starting/);
    assert.doesNotMatch(status.textContent!, /Ready|Authentication in progress/);
    dispose(); f.dom.window.close();
  });

  it("disposes subscriptions and event handlers when hidden or unloaded", () => {
    const f = fixture({ authentication: "signed-out" });
    const disposeBar = bindAuthStatusBar(f.bar, f.auth);
    const disposeSettings = bindAuthSettings(f.settings, f.auth);
    const signIn = f.settings.querySelector("button")!;
    f.update({ authentication: "signed-in" });
    const signOut = f.settings.querySelector("button")!;
    assert.equal(signIn.isConnected, false);
    assert.equal(f.listeners.size, 2);
    disposeBar(); disposeSettings();
    assert.equal(f.listeners.size, 0);
    assert.equal(f.settings.children.length, 0);
    const oldText = f.bar.textContent;
    f.update({ authentication: "signed-in" });
    assert.equal(f.bar.textContent, oldText);
    f.bar.click(); signIn.click(); signOut.click();
    assert.deepEqual(f.calls, []);
    // Reopening settings creates a single fresh section reflecting the latest state.
    const disposeAgain = bindAuthSettings(f.settings, f.auth);
    assert.equal(f.listeners.size, 1);
    assert.match(f.settings.textContent!, /Signed in/);
    disposeAgain(); f.dom.window.close();
  });
});
