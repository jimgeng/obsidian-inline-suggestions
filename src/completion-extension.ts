import { Extension, Prec, Transaction } from "@codemirror/state";
import { EditorView, keymap, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { CompletionController } from "./completion-controller";
import { createCompletionContext } from "./completion-context";
import { CompletionProvider } from "./completion-provider";
import { dismissGhost, ghostField, isGhostDismissal, showGhost, typedThroughGhost } from "./ghost-text";

interface EditorProvider extends CompletionProvider { close?(): Promise<void> }
interface Options {
  readonly provider: EditorProvider;
  readonly enabled: () => boolean;
  readonly isMarkdownEditor: (view: EditorView) => boolean;
}

export function createCompletionExtension(provider: CompletionProvider, isMarkdownEditor: (view: EditorView) => boolean): Extension {
  return createCompletionIntegration(() => provider, isMarkdownEditor).extension;
}

/** Owns every registered editor, including background panes and in-flight demos. */
export function createCompletionIntegration(
  provider: (view: EditorView) => EditorProvider,
  isMarkdownEditor: (view: EditorView) => boolean,
  enabled: () => boolean = () => true,
) {
  const editors = new Map<EditorView, AutomaticCompletion>();
  let disposed = false;
  const plugin = ViewPlugin.define(view => {
    const editor = new AutomaticCompletion(view, { provider: provider(view), isMarkdownEditor, enabled: () => !disposed && enabled() });
    editors.set(view, editor);
    return { update: (update: ViewUpdate) => editor.update(update), destroy: () => {
      editor.destroy(); editors.delete(view);
    } };
  });
  const dismiss = (view: EditorView) => {
    const cancelled = editors.get(view)?.cancel() ?? false;
    return dismissGhost(view) || cancelled;
  };
  return {
    extension: [
      Prec.highest(keymap.of([{ key: "Escape", run: dismiss }])), plugin,
    ] as Extension,
    dismiss,
    invalidate() {
      for (const [view, editor] of editors) { editor.cancel(); dismissGhost(view); }
    },
    dispose() {
      disposed = true;
      for (const [view, editor] of editors) { editor.destroy(); dismissGhost(view); }
      editors.clear();
    },
    preview(view: EditorView, demo: CompletionProvider) { return editors.get(view)?.preview(demo); },
  };
}

class AutomaticCompletion {
  private disposed = false;
  private composing = false;
  private readonly controller: CompletionController<EditorView>;
  private demo?: AbortController;
  private readonly onBlur = () => this.cancel();
  private readonly onMouseDown = () => this.cancel();
  private readonly onCompositionStart = () => { this.composing = true; this.cancel(); };
  private readonly onCompositionEnd = () => { this.composing = false; };

  constructor(private readonly view: EditorView, private readonly options: Options) {
    this.controller = new CompletionController(options.provider);
    view.contentDOM.addEventListener("blur", this.onBlur);
    view.contentDOM.addEventListener("mousedown", this.onMouseDown);
    view.contentDOM.addEventListener("compositionstart", this.onCompositionStart);
    view.contentDOM.addEventListener("compositionend", this.onCompositionEnd);
  }

  update(update: ViewUpdate): void {
    // Any new source state invalidates asynchronous work, including note switches.
    if (update.transactions.length || !this.eligible()) this.cancel();
    for (const tr of update.transactions) {
      if (isGhostDismissal(tr)) { this.cancel(); continue; }
      if (tr.selection) this.cancel();
      if (!tr.docChanged) continue;
      if (this.composing || this.view.compositionStarted) { this.cancel(); continue; }
      const event = tr.annotation(Transaction.userEvent);
      // CM6 marks committed composition input as input.type.compose[.start].
      // Never treat input.complete as typing: it includes our own ghost acceptance.
      if (event === "input.type" || event?.startsWith("input.type.compose")) {
        // Full consumption also waits for the next qualifying input; do not chain requests.
        if (!typedThroughGhost(tr)) this.schedule();
      } else {
        this.cancel();
      }
    }
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true; this.cancel();
    this.controller.dispose();
    void this.options.provider.close?.();
    this.view.contentDOM.removeEventListener("blur", this.onBlur);
    this.view.contentDOM.removeEventListener("mousedown", this.onMouseDown);
    this.view.contentDOM.removeEventListener("compositionstart", this.onCompositionStart);
    this.view.contentDOM.removeEventListener("compositionend", this.onCompositionEnd);
  }

  private eligible(automatic = true): boolean {
    const state = this.view.state;
    if (this.disposed || (automatic && !this.options.enabled()) || !this.view.hasFocus || this.view.compositionStarted || this.composing || state.readOnly ||
        state.selection.ranges.length !== 1 || !state.selection.main.empty) return false;
    return this.options.isMarkdownEditor(this.view);
  }

  private schedule(): void {
    this.cancel();
    if (!this.eligible() || this.view.state.field(ghostField, false)?.suggestion) return;
    const source = this.view.state;
    const context = createCompletionContext(source.doc, source.selection.main.head);
    this.controller.schedule(this.view, context, outcome => {
      if (outcome.status === "completed" && outcome.text !== null && this.eligible()) {
        showGhost(this.view, source, outcome.text);
      }
    });
  }

  async preview(provider: CompletionProvider): Promise<void> {
    this.cancel();
    this.view.focus();
    if (!this.eligible(false)) return;
    const request = new AbortController();
    this.demo = request;
    const source = this.view.state;
    try {
      const text = await provider.complete(createCompletionContext(source.doc, source.selection.main.head), request.signal);
      if (this.demo === request && !request.signal.aborted && this.eligible(false) && text !== null) {
        showGhost(this.view, source, text);
      }
    } catch { /* Demo failures must not interfere with editing. */ }
    finally { if (this.demo === request) this.demo = undefined; }
  }

  cancel(): boolean {
    const demo = this.demo;
    this.demo = undefined;
    demo?.abort();
    return this.controller.cancel(this.view) || !!demo;
  }
}
