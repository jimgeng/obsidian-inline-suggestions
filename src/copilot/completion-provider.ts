import { CancellationTokenSource, MessageConnection } from "vscode-jsonrpc";
import { CompletionContext, CompletionProvider } from "../completion-provider";
import { insertionFromCompletion, normalizeNewlines, positionAt } from "./range-conversion";

export interface FormattingOptions { tabSize: number; insertSpaces: boolean }
let nextDocument = 0;

/** One instance per editor. The host closes it when the editor is destroyed.
 * Virtual Markdown documents contain only the bounded context, not vault paths/full notes.
 */
export class CopilotCompletionProvider implements CompletionProvider {
  private readonly uri = `file:///inline-suggestions/editor-${++nextDocument}.md`;
  private document?: { rpc: MessageConnection; text: string; version: number };
  private queue: Promise<unknown> = Promise.resolve();
  private active?: AbortController;
  private closed = false;

  constructor(
    private readonly connection: () => MessageConnection | undefined,
    private readonly formatting: () => FormattingOptions,
  ) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  /** Sync is also available to hosts that track editor changes between requests. */
  sync(context: CompletionContext): Promise<void> {
    const text = normalizeNewlines(context.prefix) + normalizeNewlines(context.suffix);
    return this.enqueue(async () => {
      if (this.closed) return;
      const rpc = this.connection();
      if (!rpc) { this.document = undefined; return; }
      try {
        const previous = this.document;
        if (!previous || previous.rpc !== rpc) {
          await rpc.sendNotification("textDocument/didOpen", {
            textDocument: { uri: this.uri, languageId: "markdown", version: 1, text },
          });
          this.document = { rpc, text, version: 1 };
        } else if (previous.text !== text) {
          // A single incremental replacement of the changed middle keeps the protocol simple.
          let start = 0;
          while (start < previous.text.length && start < text.length && previous.text[start] === text[start]) start++;
          if (start > 0 && /[\uD800-\uDBFF]/.test(text[start - 1]!)) start--;
          let oldEnd = previous.text.length;
          let newEnd = text.length;
          while (oldEnd > start && newEnd > start && previous.text[oldEnd - 1] === text[newEnd - 1]) { oldEnd--; newEnd--; }
          if (oldEnd < previous.text.length && /[\uDC00-\uDFFF]/.test(previous.text[oldEnd]!)) { oldEnd++; newEnd++; }
          const version = previous.version + 1;
          await rpc.sendNotification("textDocument/didChange", {
            textDocument: { uri: this.uri, version },
            contentChanges: [{ range: { start: positionAt(previous.text, start), end: positionAt(previous.text, oldEnd) }, text: text.slice(start, newEnd) }],
          });
          this.document = { rpc, text, version };
        }
      } catch { this.document = undefined; }
    });
  }

  focus(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.closed && this.document && this.document.rpc === this.connection()) {
        try { await this.document.rpc.sendNotification("textDocument/didFocus", { textDocument: { uri: this.uri } }); }
        catch { this.document = undefined; }
      }
    });
  }

  async complete(context: CompletionContext, signal: AbortSignal): Promise<string | null> {
    if (this.closed || signal.aborted) return null;
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
      await this.sync(context);
      await this.focus();
      if (controller.signal.aborted || this.closed) return null;
      const document = this.document;
      if (!document || document.rpc !== this.connection()
        || document.text !== normalizeNewlines(context.prefix) + normalizeNewlines(context.suffix)) return null;
      const response = await document.rpc.sendRequest<unknown>("textDocument/inlineCompletion", {
        textDocument: { uri: this.uri, version: document.version },
        position: positionAt(normalizeNewlines(context.prefix), normalizeNewlines(context.prefix).length),
        context: { triggerKind: 2 },
        formattingOptions: this.formatting(),
      }, token.token);
      if (controller.signal.aborted || this.closed || this.document !== document || document.rpc !== this.connection()) return null;
      const items = (response as { items?: unknown[] } | null)?.items;
      if (!Array.isArray(items)) return null;
      for (const item of items) {
        const text = insertionFromCompletion(context, item);
        if (text !== null) return text;
      }
      return null;
    };
    try {
      // Includes ServerCancelled (-32802): transport/server failures are unobtrusive misses.
      return await Promise.race([request().catch(() => null), aborted]);
    } finally {
      signal.removeEventListener("abort", forwardAbort);
      controller.signal.removeEventListener("abort", abort);
      token.dispose();
      if (this.active === controller) this.active = undefined;
    }
  }

  close(): Promise<void> {
    this.closed = true;
    this.active?.abort();
    return this.enqueue(async () => {
      const document = this.document;
      this.document = undefined;
      if (document && document.rpc === this.connection()) {
        try { await document.rpc.sendNotification("textDocument/didClose", { textDocument: { uri: this.uri } }); }
        catch { /* Connection shutdown needs no recovery here. */ }
      }
    });
  }
}
