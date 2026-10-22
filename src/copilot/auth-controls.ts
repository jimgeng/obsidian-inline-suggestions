import type { Setting } from "obsidian";
import type { PluginSettingsStore } from "../plugin-settings";
import type { AuthState, CopilotAuth } from "./auth";

type Controls = Pick<CopilotAuth, "state" | "subscribe" | "signIn" | "signOut">;

function description(state: AuthState): string {
  if (!state.available) return "Copilot server unavailable or starting. Check the Node path and server installation if this persists.";
  const identity = state.authentication === "signed-in" ? "Signed in"
    : state.authentication === "signed-out" ? "Signed out. Sign in to use Copilot." : "Authentication status unknown";
  const parts = [identity];
  const status = state.status;
  if (status) {
    // A sign-in-required Error is expected when signed out, not a separate failure.
    // Do not hide unrelated errors just because authentication is signed out.
    const health = {
      Normal: state.authentication === "signed-in" ? "Ready" : "",
      Error: status.requiresSignIn ? "" : "Copilot access problem",
      Warning: "Temporary service issue",
      Inactive: "Suggestions unavailable for this file (size or content exclusions)",
    }[status.kind];
    if (health) parts.push(health);
    if (status.busy) parts.push("Copilot is busy");
  }
  if (state.pending) parts.push("Authentication in progress");
  return parts.join(" — ");
}

/** Returns a disposer so the plugin owns listeners and subscriptions. */
export function bindAuthStatusBar(element: HTMLElement, auth: Controls, settings: PluginSettingsStore): () => void {
  const activate = () => {
    const state = auth.state;
    if (state.authentication === "signed-in") {
      void settings.setAutomaticSuggestions(!settings.current.automaticSuggestions);
    } else if (state.available && !state.pending && state.authentication === "signed-out") {
      void auth.signIn();
    }
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate();
    }
  };
  element.addEventListener("click", activate);
  element.addEventListener("keydown", keydown);
  const render = () => {
    const state = auth.state;
    const signedIn = state.authentication === "signed-in";
    const clickable = signedIn || (state.available && !state.pending && state.authentication === "signed-out");
    const off = signedIn && !settings.current.automaticSuggestions;
    const label = state.authentication === "signed-out" ? "signed out" : off ? "off" : state.status?.kind.toLowerCase() ?? "unavailable";
    const action = signedIn ? `Turn ${off ? "on" : "off"} automatic suggestions` : "Sign in to Copilot";
    element.textContent = `Copilot: ${label}${!off && (state.status?.busy || state.pending) ? " (busy)" : ""}`;
    element.title = `${description(state)}${clickable ? `. Click to ${action.toLowerCase()}.` : ""}`;
    element.classList.toggle("mod-clickable", clickable);
    if (clickable) {
      element.setAttribute("role", "button");
      element.tabIndex = 0;
      element.setAttribute("aria-label", `Copilot: ${label}. ${action}`);
      if (signedIn) element.setAttribute("aria-pressed", String(settings.current.automaticSuggestions));
      else element.removeAttribute("aria-pressed");
    } else {
      element.removeAttribute("role");
      element.removeAttribute("tabindex");
      element.removeAttribute("aria-label");
      element.removeAttribute("aria-pressed");
    }
  };
  const unsubscribe = auth.subscribe(render);
  const unsubscribeSettings = settings.subscribe(render);
  return () => {
    unsubscribe();
    unsubscribeSettings();
    element.removeEventListener("click", activate);
    element.removeEventListener("keydown", keydown);
  };
}

export function bindAuthSettings(container: HTMLElement, auth: Controls,
  createSetting: (container: HTMLElement) => Setting): () => void {
  const heading = createSetting(container).setName("Copilot authentication").setHeading();
  const row = createSetting(container).setName("Authentication status");
  const status = row.descEl;
  status.setAttribute("role", "status");
  const controls = row.controlEl;
  let active = true;
  let signIn!: HTMLButtonElement;
  let signOut!: HTMLButtonElement;
  row.addButton(button => {
    signIn = button.setButtonText("Sign in").setCta().onClick(() => { if (active) void auth.signIn(); }).buttonEl;
  });
  row.addButton(button => {
    signOut = button.setButtonText("Sign out").onClick(() => { if (active) void auth.signOut(); }).buttonEl;
  });
  const unsubscribe = auth.subscribe(state => {
    status.textContent = description(state);
    signIn.disabled = signOut.disabled = !state.available || state.pending;
    // Obsidian's button display rule overrides HTML `hidden`; detach irrelevant actions.
    const button = state.authentication === "signed-out" ? signIn
      : state.authentication === "signed-in" ? signOut : undefined;
    if (button !== signIn) signIn.remove();
    if (button !== signOut) signOut.remove();
    // Leave an already-attached button in place so health updates preserve focus.
    if (button && button.parentElement !== controls) controls.append(button);
  });
  return () => {
    unsubscribe();
    active = false;
    heading.settingEl.remove();
    row.settingEl.remove();
  };
}
