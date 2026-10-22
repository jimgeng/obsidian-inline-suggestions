import { CancellationTokenSource, MessageConnection } from "vscode-jsonrpc";

/** Raw language-server values; these are not authentication states or UI labels. */
export type StatusKind =
  | "Normal"   // Server operating normally.
  | "Error"    // Authentication/authorization prevents use (including ordinary signed-out state).
  | "Warning"  // Temporary issue, such as a failed HTTP request.
  | "Inactive"; // Current file excluded by size or content rules; not a disconnected server.
export interface CopilotStatus {
  kind: StatusKind;
  /** Work in progress, independent of severity and authentication. */
  busy: boolean;
  /** Explicit sign-in hint in this notification; absent means no such hint. */
  requiresSignIn?: true;
}
export interface AuthState {
  authentication: "unknown" | "signed-in" | "signed-out";
  status?: CopilotStatus;
  pending: boolean;
  available: boolean;
}
export interface AuthHost {
  ready(): boolean;
  /** Stop the old process (including device-code polling), then start a fresh one. */
  resetSession(): Promise<void>;
  status?(status: CopilotStatus | undefined): void;
  notice(message: string): void;
  openUrl(url: string): Promise<void>;
  showCode(code: string, proceed: () => void, cancel: () => void): { close(): void };
}

interface Operation {
  rpc: MessageConnection;
  cancellation: CancellationTokenSource;
  modal?: { close(): void };
  executing: boolean;
  signIn: boolean;
}

/** Authentication only: credentials remain entirely inside the official server. */
export class CopilotAuth {
  private rpc?: MessageConnection;
  private operation?: Operation;
  private hinted = false;
  private retiring?: Promise<void>;
  private action = 0;
  private authentication: AuthState["authentication"] = "unknown";
  private serverStatus?: CopilotStatus;
  private readonly listeners = new Set<(state: AuthState) => void>();

  get state(): AuthState {
    return {
      authentication: this.authentication, status: this.serverStatus,
      pending: !!this.operation || !!this.retiring, available: !!this.rpc && this.host.ready(),
    };
  }

  /** Unknown authentication and pending sign-out must never send note context. */
  get canComplete(): boolean {
    const state = this.state;
    return state.available && !state.pending && state.authentication === "signed-in" && state.status?.kind !== "Error";
  }

  subscribe(listener: (state: AuthState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => { this.listeners.delete(listener); };
  }

  connectionChanged(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  constructor(private readonly host: AuthHost) {}

  attach(rpc: MessageConnection): () => void {
    this.cancel(false);
    this.rpc = rpc;
    this.authentication = "unknown";
    this.serverStatus = undefined;
    this.connectionChanged();
    const status = rpc.onNotification("didChangeStatus", (value: unknown) => {
      if (this.rpc !== rpc || !value || typeof value !== "object") return;
      const data = value as { kind?: unknown; busy?: unknown; message?: unknown; command?: { command?: unknown } };
      if (typeof data.kind !== "string" || !["Normal", "Error", "Warning", "Inactive"].includes(data.kind)) return;
      const needsSignIn = data.command?.command === "github.copilot.signIn"
        || (typeof data.message === "string" && /not signed (in|into)|signed out|sign in again/i.test(data.message));
      // Retain the reason, not arbitrary server text or command arguments, for UI classification.
      this.serverStatus = {
        kind: data.kind as StatusKind, busy: data.busy === true,
        ...(needsSignIn ? { requiresSignIn: true as const } : {}),
      };
      this.host.status?.(this.serverStatus);
      if (needsSignIn) this.authentication = "signed-out";
      else if (data.kind === "Normal") this.authentication = "signed-in";
      // Other errors/warnings describe server health, not necessarily authentication.
      this.connectionChanged();
      if (!this.hinted && needsSignIn) {
        this.hinted = true;
        this.host.notice("Copilot is not signed in. Use the ‘Sign in to Copilot’ command to connect.");
      }
    });
    const showDocument = rpc.onRequest("window/showDocument", async (params: { uri?: unknown }) => {
      // Acknowledge suppressed requests as handled: success:false makes the server
      // fall back to opening the browser natively, even after cancellation.
      const op = this.operation;
      if (this.rpc !== rpc || !op?.executing || typeof params?.uri !== "string") return { success: true };
      let url: URL;
      try { url = new URL(params.uri); }
      catch { return { success: true }; }
      if (url.protocol !== "https:" && url.protocol !== "http:") return { success: true };
      try { await this.host.openUrl(url.href); }
      catch {
        if (this.current(op)) {
          this.host.notice("Could not open the Copilot sign-in page. Please try signing in again.");
          this.cancel();
        }
      }
      return { success: true };
    });
    return () => {
      status.dispose();
      showDocument.dispose();
      if (this.rpc === rpc) {
        this.cancel(false);
        this.rpc = undefined;
        this.serverStatus = undefined;
        this.authentication = "unknown";
        this.host.status?.(undefined);
        this.connectionChanged();
      }
    };
  }

  async signIn(): Promise<void> {
    const action = this.action;
    const rpc = await this.available();
    if (!rpc || this.operation || action !== this.action) return;
    const op: Operation = { rpc, cancellation: new CancellationTokenSource(), executing: false, signIn: true };
    this.operation = op;
    this.connectionChanged();
    try {
      const result = await rpc.sendRequest<{
        status?: string; userCode?: string; command?: { command: string; arguments?: unknown[] };
      }>("signIn", {}, op.cancellation.token);
      if (!this.current(op)) return;
      if (result?.status === "AlreadySignedIn") {
        this.authentication = "signed-in";
        this.host.notice("Copilot is already signed in.");
        this.finish(op);
        return;
      }
      if (!result || typeof result.userCode !== "string" || !result.userCode
        || typeof result.command?.command !== "string"
        || (result.command.arguments !== undefined && !Array.isArray(result.command.arguments))) {
        throw new Error("Invalid sign-in response");
      }
      this.authentication = "signed-out";
      this.connectionChanged();
      const command = result.command;
      op.modal = this.host.showCode(result.userCode, () => {
        if (this.current(op) && !op.executing) void this.execute(op, command);
      }, () => { if (this.current(op)) this.cancel(); });
    } catch {
      if (this.current(op)) {
        this.host.notice("Copilot sign-in failed. Please try again.");
        this.cancel();
      }
    }
  }

  async signOut(): Promise<void> {
    const action = ++this.action;
    this.cancel();
    const rpc = await this.available();
    if (!rpc || action !== this.action) return;
    const op: Operation = { rpc, cancellation: new CancellationTokenSource(), executing: false, signIn: false };
    this.operation = op;
    this.connectionChanged();
    try {
      await rpc.sendRequest("signOut", {}, op.cancellation.token);
      if (this.current(op)) {
        this.authentication = "signed-out";
        this.host.notice("Signed out of Copilot.");
      }
    } catch {
      if (this.current(op)) this.host.notice("Copilot sign-out failed. Please try again.");
    } finally { this.finish(op); }
  }

  private async execute(op: Operation, command: { command: string; arguments?: unknown[] }): Promise<void> {
    op.executing = true;
    try {
      await op.rpc.sendRequest("workspace/executeCommand", {
        command: command.command, arguments: command.arguments ?? [],
      }, op.cancellation.token);
      // didChangeStatus, not this response, is the source of status-bar truth.
    } catch {
      if (this.current(op)) {
        this.host.notice("Copilot sign-in failed or expired. Please try again.");
        this.cancel();
      }
    } finally { this.finish(op); }
  }

  private async available(): Promise<MessageConnection | undefined> {
    await this.retiring;
    if (this.rpc && this.host.ready()) return this.rpc;
    this.host.notice("Copilot server is not ready. Check its installation and Node path, then reload the plugin.");
    return undefined;
  }

  private current(op: Operation): boolean { return this.operation === op && this.rpc === op.rpc; }

  private finish(op: Operation): void {
    if (!this.current(op)) return;
    this.operation = undefined;
    op.cancellation.dispose();
    op.modal?.close();
    this.connectionChanged();
  }

  private cancel(retire = true): void {
    const op = this.operation;
    if (!op) return;
    this.operation = undefined;
    op.cancellation.cancel();
    op.cancellation.dispose();
    op.modal?.close();
    if (retire && op.signIn && !this.retiring) {
      // Legacy signIn starts polling before executeCommand and ignores RPC
      // cancellation. Only terminating that process reliably abandons the flow.
      this.retiring = Promise.resolve().then(() => this.host.resetSession()).catch(() => {
        this.host.notice("Copilot server could not restart. Reload the plugin before signing in again.");
      }).finally(() => {
        this.retiring = undefined;
        this.connectionChanged();
      });
    }
    this.connectionChanged();
  }
}
