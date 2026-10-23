import { CancellationTokenSource, MessageConnection } from "vscode-jsonrpc";
import { CompletionContext, CompletionProvider } from "../completion-provider";
import { insertionFromCompletion, normalizeNewlines, positionAt } from "./range-conversion";

export interface FormattingOptions { tabSize: number; insertSpaces: boolean }
export interface CompletionTransportOptions {
  writeTimeoutMs?: number;
  /** Retire the transport before using it again: a timed-out write may still arrive. */
  onStalled?(rpc: MessageConnection): void;
}
interface DocumentSession {
  rpc: MessageConnection;
  queue: Promise<unknown>;
  document?: { text: string; version: number };
  retired: boolean;
  cancelled: Promise<never>;
  cancel(): void;
}
let nextDocument = 0;

/** One instance per editor. Virtual documents contain bounded context, not note paths. */
export class CopilotCompletionProvider implements CompletionProvider {
  private readonly uri = `file:///inline-suggestions/editor-${++nextDocument}.md`;
  private session?: DocumentSession;
  private readonly unusable = new WeakSet<MessageConnection>();
  private revision = 0;
  private active?: AbortController;
  private closed = false;

  constructor(
    private readonly connection: () => MessageConnection | undefined,
    private readonly formatting: () => FormattingOptions,
    private readonly enabled: () => boolean = () => true,
    private readonly transport: CompletionTransportOptions = {},
  ) {}

  private currentSession(): DocumentSession | undefined {
    const rpc = this.connection();
    if (this.session?.rpc !== rpc) {
      if (this.session) this.retire(this.session);
      this.session = undefined;
    }
    if (!rpc || this.unusable.has(rpc)) return undefined;
    if (!this.session) {
      let cancel!: () => void;
      const cancelled = new Promise<never>((_, reject) => { cancel = () => reject(new Error("Document session retired.")); });
      void cancelled.catch(() => {});
      this.session = { rpc, queue: Promise.resolve(), retired: false, cancelled, cancel };
    }
    return this.session;
  }

  private retire(session: DocumentSession): void {
    session.retired = true;
    session.document = undefined;
    session.cancel();
  }

  private enqueue<T>(session: DocumentSession, operation: () => Promise<T>): Promise<T | undefined> {
    const result = session.queue.then(() => {
      if (session.retired || this.connection() !== session.rpc) return undefined;
      return operation();
    });
    session.queue = result.catch(() => {});
    return result;
  }

  private async write(session: DocumentSession, method: string, params: unknown): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        session.rpc.sendNotification(method, params), session.cancelled,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Document write timed out.")), this.transport.writeTimeoutMs ?? 5000);
        }),
      ]);
    } catch {
      if (!session.retired && this.connection() === session.rpc) {
        // Do not reopen on the same connection: the old write may complete later.
        this.unusable.add(session.rpc);
        this.retire(session);
        try { this.transport.onStalled?.(session.rpc); } catch { /* Host reporting cannot break editing. */ }
      }
      throw new Error("Document transport unavailable.");
    } finally { clearTimeout(timer); }
  }

  /** Independent document changes also invalidate completion snapshots. */
  sync(context: CompletionContext): Promise<void> {
    return this.syncContext(context, () => true);
  }

  private async syncContext(context: CompletionContext, fresh: () => boolean): Promise<void> {
    const revision = ++this.revision;
    if (this.closed || !this.enabled()) return;
    const session = this.currentSession();
    if (!session) return;
    const text = normalizeNewlines(context.prefix) + normalizeNewlines(context.suffix);
    await this.enqueue(session, async () => {
      if (this.closed || !this.enabled() || !fresh() || revision !== this.revision) return;
      const previous = session.document;
      if (!previous) {
        await this.write(session, "textDocument/didOpen", {
          textDocument: { uri: this.uri, languageId: "markdown", version: 1, text },
        });
        if (!session.retired) session.document = { text, version: 1 };
      } else if (previous.text !== text) {
        let start = 0;
        while (start < previous.text.length && start < text.length && previous.text[start] === text[start]) start++;
        if (start > 0 && /[\uD800-\uDBFF]/.test(text[start - 1]!)) start--;
        let oldEnd = previous.text.length;
        let newEnd = text.length;
        while (oldEnd > start && newEnd > start && previous.text[oldEnd - 1] === text[newEnd - 1]) { oldEnd--; newEnd--; }
        if (oldEnd < previous.text.length && /[\uDC00-\uDFFF]/.test(previous.text[oldEnd]!)) { oldEnd++; newEnd++; }
        const version = previous.version + 1;
        await this.write(session, "textDocument/didChange", {
          textDocument: { uri: this.uri, version },
          contentChanges: [{ range: { start: positionAt(previous.text, start), end: positionAt(previous.text, oldEnd) }, text: text.slice(start, newEnd) }],
        });
        if (!session.retired) session.document = { text, version };
      }
    }).catch(() => {});
  }

  async focus(): Promise<void> {
    if (this.closed || !this.enabled()) return;
    const session = this.currentSession();
    if (!session) return;
    await this.enqueue(session, async () => {
      if (!this.closed && this.enabled() && session.document) {
        await this.write(session, "textDocument/didFocus", { textDocument: { uri: this.uri } });
      }
    }).catch(() => {});
  }

  async complete(context: CompletionContext, signal: AbortSignal): Promise<string | null> {
    if (this.closed || !this.enabled() || signal.aborted) return null;
    this.active?.abort();
    const controller = new AbortController();
    this.active = controller;
    const token = new CancellationTokenSource();
    let finishAbort!: (value: null) => void;
    const aborted = new Promise<null>(resolve => { finishAbort = resolve; });
    const abort = () => { token.cancel(); finishAbort(null); };
    const forwardAbort = () => controller.abort();
    controller.signal.addEventListener("abort", abort, { once: true });
    signal.addEventListener("abort", forwardAbort, { once: true });
    const request = async (): Promise<string | null> => {
      const revision = this.revision + 1;
      await this.syncContext(context, () => !controller.signal.aborted);
      if (controller.signal.aborted) return null;
      await this.focus();
      if (controller.signal.aborted || this.closed || !this.enabled() || revision !== this.revision) return null;
      const session = this.currentSession();
      const document = session?.document;
      if (!session || !document || document.text !== normalizeNewlines(context.prefix) + normalizeNewlines(context.suffix)) return null;
      const response = await Promise.race([session.rpc.sendRequest<unknown>("textDocument/inlineCompletion", {
        textDocument: { uri: this.uri, version: document.version },
        position: positionAt(normalizeNewlines(context.prefix), normalizeNewlines(context.prefix).length),
        context: { triggerKind: 2 }, formattingOptions: this.formatting(),
      }, token.token), session.cancelled]);
      if (controller.signal.aborted || this.closed || !this.enabled() || revision !== this.revision || session.retired || session.document !== document || session.rpc !== this.connection()) return null;
      const items = (response as { items?: unknown[] } | null)?.items;
      if (!Array.isArray(items)) return null;
      for (const item of items) {
        const text = insertionFromCompletion(context, item);
        if (text !== null) return text;
      }
      return null;
    };
    try { return await Promise.race([request().catch(() => null), aborted]); }
    finally {
      signal.removeEventListener("abort", forwardAbort);
      controller.signal.removeEventListener("abort", abort);
      token.dispose();
      if (this.active === controller) this.active = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.active?.abort();
    const session = this.currentSession();
    if (!session) return;
    await this.enqueue(session, async () => {
      if (session.document) await this.write(session, "textDocument/didClose", { textDocument: { uri: this.uri } });
    }).catch(() => {});
    this.retire(session);
  }
}
