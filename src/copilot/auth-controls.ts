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
export function bindAuthStatusBar(element: HTMLElement, auth: Controls): () => void {
  const signIn = () => {
    const state = auth.state;
    if (state.available && !state.pending && state.authentication === "signed-out") void auth.signIn();
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      signIn();
    }
  };
  element.addEventListener("click", signIn);
  element.addEventListener("keydown", keydown);
  const unsubscribe = auth.subscribe(state => {
    const clickable = state.available && !state.pending && state.authentication === "signed-out";
    const label = state.authentication === "signed-out" ? "signed out" : state.status?.kind.toLowerCase() ?? "unavailable";
    element.textContent = `Copilot: ${label}${state.status?.busy || state.pending ? " (busy)" : ""}`;
    element.title = `${description(state)}${clickable ? ". Click to sign in." : ""}`;
    element.classList.toggle("mod-clickable", clickable);
    if (clickable) {
      element.setAttribute("role", "button");
      element.tabIndex = 0;
      element.setAttribute("aria-label", "Copilot: signed out. Sign in to Copilot");
    } else {
      element.removeAttribute("role");
      element.removeAttribute("tabindex");
      element.removeAttribute("aria-label");
    }
  });
  return () => {
    unsubscribe();
    element.removeEventListener("click", signIn);
    element.removeEventListener("keydown", keydown);
  };
}

export function bindAuthSettings(container: HTMLElement, auth: Controls): () => void {
  const document = container.ownerDocument;
  const heading = document.createElement("h2");
  heading.textContent = "Copilot authentication";
  const row = document.createElement("div");
  row.className = "setting-item";
  const info = row.appendChild(document.createElement("div"));
  info.className = "setting-item-info";
  const name = info.appendChild(document.createElement("div"));
  name.className = "setting-item-name";
  name.textContent = "Authentication status";
  const status = info.appendChild(document.createElement("div"));
  status.className = "setting-item-description";
  status.setAttribute("role", "status");
  const controls = row.appendChild(document.createElement("div"));
  controls.className = "setting-item-control";
  const signIn = document.createElement("button");
  signIn.textContent = "Sign in";
  signIn.className = "mod-cta";
  const signOut = document.createElement("button");
  signOut.textContent = "Sign out";
  const onSignIn = () => { void auth.signIn(); };
  const onSignOut = () => { void auth.signOut(); };
  signIn.addEventListener("click", onSignIn);
  signOut.addEventListener("click", onSignOut);
  container.append(heading, row);
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
    signIn.removeEventListener("click", onSignIn);
    signOut.removeEventListener("click", onSignOut);
    heading.remove();
    row.remove();
  };
}
