import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createMessageConnection, MessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import { discoverServer, DiscoveryError, discoveryMessages, ServerPaths } from "./discovery";

const startupMessages = {
  discovery: "Copilot installation discovery failed. Check Node.js, npm, and the global language server installation.",
  spawn: "Copilot language server could not start. Check the Node.js and language server installation and process permissions.",
  transport: "Copilot language server connection failed. Reload the plugin to try again.",
  clientHandlers: "Copilot client handler setup failed. Reload the plugin; if this persists, report a plugin integration issue.",
  initialize: "Copilot language server initialization failed or timed out. Reload the plugin to try again.",
  configuration: "Copilot language server configuration failed or timed out. Reload the plugin to try again.",
  readyCallback: "Copilot ready callback failed. Reload the plugin; if this persists, report a plugin integration issue.",
} as const;

type StartupStage = keyof typeof startupMessages;

export interface ServerOptions {
  nodePath: string;
  vaultPath: string;
  editorVersion: string;
  pluginVersion: string;
  onFailure(message: string): void;
  onReady?(): void;
  /** Install client handlers before initialize; dispose them with this connection. */
  configureConnection?(rpc: MessageConnection): () => void;
}

export interface ServerHost {
  discover(nodePath: string): Promise<ServerPaths>;
  spawn(paths: ServerPaths, cwd: string): ChildProcessWithoutNullStreams;
  connect(child: ChildProcessWithoutNullStreams): MessageConnection;
  timeoutMs: number;
  initializeTimeoutMs: number;
}

const defaultHost: ServerHost = {
  discover: discoverServer,
  spawn: (paths, cwd) => spawn(paths.node, [paths.server, "--stdio"], {
    cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false,
  }),
  connect: child => createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin)),
  timeoutMs: 1500,
  initializeTimeoutMs: 10_000,
};

async function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Language server timed out.")), ms);
    })]);
  } finally { clearTimeout(timer); }
}

interface Session {
  child: ChildProcessWithoutNullStreams;
  rpc: MessageConnection;
  ready: boolean;
  failed: boolean;
  exited: boolean;
  exit: Promise<void>;
  cancel: () => void;
  cancelled: Promise<never>;
  cleanup?: Promise<void>;
  releaseClient?: () => void;
}

/** Owns the process/transport only; no editor state, authentication UI, or note text. */
export class CopilotServerManager {
  private active = false;
  private generation = 0;
  private restarted = false;
  private session?: Session;
  private starting?: Promise<void>;

  constructor(private readonly options: ServerOptions, private readonly host = defaultHost) {}

  get connection(): MessageConnection | undefined {
    return this.session?.ready && !this.session.failed ? this.session.rpc : undefined;
  }

  start(): Promise<void> {
    // One active generation owns startup and any bounded crash recovery.
    if (this.active) return this.starting ?? Promise.resolve();
    this.active = true;
    const generation = ++this.generation;
    this.starting = this.launch(generation);
    return this.starting;
  }

  async stop(): Promise<void> {
    // Invalidate pending discovery/startup/recovery before disposing the current session.
    this.active = false;
    ++this.generation;
    const session = this.session;
    this.session = undefined;
    if (session) await this.dispose(session, true);
  }

  private current(generation: number): boolean {
    return this.active && this.generation === generation;
  }

  private async launch(generation: number): Promise<void> {
    let session: Session | undefined;
    let stage: StartupStage = "discovery";
    let eventFailure: "spawn" | "transport" | undefined;
    try {
      const paths = await this.host.discover(this.options.nodePath);
      if (!this.current(generation)) return;
      stage = "spawn";
      const child = this.host.spawn(paths, this.options.vaultPath);
      // stderr may contain personal/server data: drain it, but never log it.
      child.stderr.resume();
      let resolveExit!: () => void;
      let exited = false;
      const exit = new Promise<void>(resolve => { resolveExit = resolve; });
      let cancel!: () => void;
      const cancelled = new Promise<never>((_, reject) => { cancel = () => reject(new Error("Server stopped.")); });
      // Attach immediately so disposal outside an active initialize cannot reject unhandled.
      void cancelled.catch(() => {});
      child.once("exit", () => { exited = true; if (session) session.exited = true; resolveExit(); });
      const fail = () => { if (session) this.failed(session, generation); };
      child.on("error", () => { if (!session?.failed) eventFailure = "spawn"; fail(); });
      child.on("exit", () => { if (session && !session.failed) eventFailure ??= "spawn"; fail(); });
      stage = "transport";
      let rpc: MessageConnection;
      try { rpc = this.host.connect(child); }
      catch {
        await this.terminate(child, exit, () => exited);
        throw new Error("Unable to create the language server connection.");
      }
      session = { child, rpc, ready: false, failed: false, exited: false, exit, cancel, cancelled };
      this.session = session;
      const transportFailed = () => { eventFailure ??= "transport"; fail(); };
      rpc.onClose(transportFailed);
      rpc.onError(transportFailed);
      rpc.onRequest("workspace/configuration", (params: { items: { section?: string }[] }) =>
        params.items.map(item => item.section === "telemetry" ? { telemetryLevel: "off" }
          : item.section === "telemetry.telemetryLevel" ? "off" : null));
      stage = "clientHandlers";
      session.releaseClient = this.options.configureConnection?.(rpc);
      stage = "transport";
      rpc.listen();
      const workspaceUri = pathToFileURL(this.options.vaultPath).href;
      stage = "initialize";
      await deadline(Promise.race([rpc.sendRequest("initialize", {
        processId: process.pid,
        workspaceFolders: [{ uri: workspaceUri, name: basename(this.options.vaultPath) }],
        capabilities: {
          workspace: { workspaceFolders: true, configuration: true },
          window: { showDocument: { support: true } },
        },
        initializationOptions: {
          editorInfo: { name: "Obsidian", version: this.options.editorVersion },
          editorPluginInfo: { name: "Inline Suggestions", version: this.options.pluginVersion },
        },
      }), cancelled]), this.host.initializeTimeoutMs);
      if (!this.current(generation) || session.failed) throw new Error("Server startup cancelled.");
      await deadline(Promise.race([rpc.sendNotification("initialized", {}), cancelled]), this.host.initializeTimeoutMs);
      if (!this.current(generation) || session.failed) throw new Error("Server startup cancelled.");
      stage = "configuration";
      await deadline(Promise.race([rpc.sendNotification("workspace/didChangeConfiguration", { settings: { telemetry: { telemetryLevel: "off" } } }), cancelled]), this.host.initializeTimeoutMs);
      if (!this.current(generation) || session.failed) throw new Error("Server startup cancelled.");
      session.ready = true;
      stage = "readyCallback";
      this.options.onReady?.();
    } catch (error) {
      // Only locally defined messages cross the integration boundary, never exception text.
      const message = stage === "discovery" && error instanceof DiscoveryError
        ? discoveryMessages[error.code] ?? startupMessages.discovery
        : startupMessages[eventFailure ?? stage];
      if (session) await this.dispose(session, false);
      if (this.current(generation)) this.options.onFailure(message);
    }
  }

  private failed(session: Session, generation: number): void {
    if (session.failed) return;
    const wasReady = session.ready;
    session.failed = true;
    session.ready = false;
    session.cancel();
    session.releaseClient?.();
    session.releaseClient = undefined;
    if (!this.current(generation) || !wasReady) return;
    // launch owns startup failures; only a ready session earns recovery.
    // The restart budget is never reset on success, preventing a crash loop.
    const retry = wasReady && !this.restarted;
    if (retry) this.restarted = true;
    void this.dispose(session, false).then(() => {
      if (!this.current(generation)) return;
      if (retry) this.starting = this.launch(generation);
      else this.options.onFailure("Copilot server stopped. Editing is unaffected; reload the plugin to try again.");
    });
  }

  private dispose(session: Session, graceful: boolean): Promise<void> {
    // All shutdown paths share one cleanup promise; cancellation prevents late readiness.
    if (session.cleanup) return session.cleanup;
    const wasReady = session.ready;
    session.ready = false;
    session.failed = true;
    session.cancel();
    session.releaseClient?.();
    session.releaseClient = undefined;
    session.cleanup = (async () => {
      try {
        if (graceful && wasReady && !session.exited) {
          try {
            await deadline(session.rpc.sendRequest("shutdown"), this.host.timeoutMs);
            await deadline(session.rpc.sendNotification("exit"), this.host.timeoutMs);
            await deadline(session.exit, this.host.timeoutMs);
          } catch { /* Force termination below if the server is unresponsive. */ }
        }
      } finally {
        try { session.rpc.dispose(); }
        finally { await this.terminate(session.child, session.exit, () => session.exited); }
      }
    })();
    return session.cleanup;
  }

  private async terminate(child: ChildProcessWithoutNullStreams, exit: Promise<void>, exited: () => boolean): Promise<void> {
    // Signals request termination; wait for exit, but bound both waits if exit never arrives.
    try {
      if (!exited()) {
        child.kill();
        try { await deadline(exit, this.host.timeoutMs); }
        catch {
          child.kill("SIGKILL");
          try { await deadline(exit, this.host.timeoutMs); }
          catch { /* No exit confirmation; still release streams after the deadline. */ }
        }
      }
    } finally {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
}
