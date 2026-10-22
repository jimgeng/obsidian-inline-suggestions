import type { AuthState, CopilotAuth } from "./auth";

type Controls = Pick<CopilotAuth, "state" | "subscribe" | "signIn" | "signOut">;

function description(state: AuthState): string {
  if (!state.available) return "Copilot server unavailable or starting. Check the Node path and server installation if this persists.";
  const identity = state.authentication === "signed-in" ? "Signed in"
    : state.authentication === "signed-out" ? "Signed out" : "Authentication status unknown";
  const health = state.status ? ` — ${state.status.kind.toLowerCase()}${state.status.busy ? " (busy)" : ""}` : "";
  return `${identity}${health}${state.pending ? " — authentication in progress" : ""}`;
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
  const signIn = controls.appendChild(document.createElement("button"));
  signIn.textContent = "Sign in";
  signIn.className = "mod-cta";
  const signOut = controls.appendChild(document.createElement("button"));
  signOut.textContent = "Sign out";
  const onSignIn = () => { void auth.signIn(); };
  const onSignOut = () => { void auth.signOut(); };
  signIn.addEventListener("click", onSignIn);
  signOut.addEventListener("click", onSignOut);
  container.append(heading, row);
  const unsubscribe = auth.subscribe(state => {
    status.textContent = description(state);
    // Unknown includes entitlement/network failures: allow either explicit action
    // rather than guessing that every Error means the account is signed out.
    signIn.hidden = state.authentication === "signed-in";
    signOut.hidden = state.authentication === "signed-out";
    signIn.disabled = signOut.disabled = !state.available || state.pending;
  });
  return () => {
    unsubscribe();
    signIn.removeEventListener("click", onSignIn);
    signOut.removeEventListener("click", onSignOut);
    heading.remove();
    row.remove();
  };
}
