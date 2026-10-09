import { EditorState, Extension, Prec, Transaction } from "@codemirror/state";
import { EditorView, keymap, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { CompletionController } from "./completion-controller";
import { createCompletionContext } from "./completion-context";
import { CompletionProvider } from "./completion-provider";
import { dismissGhost, ghostField, isGhostDismissal, showGhost } from "./ghost-text";

interface Options { readonly controller: CompletionController<EditorView> }
let editorInfoField: unknown;
export function setCompletionEditorInfoField(field: unknown): void { editorInfoField = field; }
export function createCompletionExtension(provider: CompletionProvider): Extension {
  const controller = new CompletionController<EditorView>(provider);
  return [
    Prec.highest(keymap.of([{ key: "Escape", run: view => {
      const cancelled = controller.cancel(view);
      return dismissGhost(view) || cancelled;
    } }])),
    ViewPlugin.define(view => new AutomaticCompletion(view, { controller })),
  ];
}

class AutomaticCompletion {
  private disposed = false;
  private composing = false;
  private compositionStarted = false;
  private readonly onBlur = () => this.cancel();
  private readonly onMouseDown = () => this.cancel();
  private readonly onCompositionStart = () => { this.composing = true; this.compositionStarted = true; this.cancel(); };
  private readonly onCompositionEnd = () => { this.composing = false; };

  constructor(private readonly view: EditorView, private readonly options: Options) {
    view.contentDOM.addEventListener("blur", this.onBlur);
    view.contentDOM.addEventListener("mousedown", this.onMouseDown);
    view.contentDOM.addEventListener("compositionstart", this.onCompositionStart);
    view.contentDOM.addEventListener("compositionend", this.onCompositionEnd);
  }

  update(update: ViewUpdate): void {
    // Eligibility can change through reconfiguration without a document transaction.
    if (!this.eligible()) this.cancel();
    for (const tr of update.transactions) {
      if (isGhostDismissal(tr)) { this.cancel(); continue; }
      if (tr.selection) this.cancel();
      if (!tr.docChanged) continue;
      if (this.composing || this.view.compositionStarted) { this.cancel(); continue; }
      const event = tr.annotation(Transaction.userEvent);
      // CM6 marks committed composition input as input.type.compose[.start].
      // Never treat input.complete as typing: it includes our own ghost acceptance.
      if (event === "input.type" || event?.startsWith("input.type.compose")) {
        this.compositionStarted = false;
        this.schedule();
      } else {
        this.compositionStarted = false;
        this.cancel();
      }
    }
  }

  destroy(): void {
    this.disposed = true; this.cancel();
    this.view.contentDOM.removeEventListener("blur", this.onBlur);
    this.view.contentDOM.removeEventListener("mousedown", this.onMouseDown);
    this.view.contentDOM.removeEventListener("compositionstart", this.onCompositionStart);
    this.view.contentDOM.removeEventListener("compositionend", this.onCompositionEnd);
  }

  private eligible(): boolean {
    const state = this.view.state;
    if (this.disposed || !this.view.hasFocus || this.view.compositionStarted || this.composing || state.readOnly ||
        state.selection.ranges.length !== 1 || !state.selection.main.empty || !editorInfoField) return false;
    try {
      const info = (state as EditorState & { field(field: unknown, require?: boolean): unknown }).field(editorInfoField, false);
      return !!info && typeof info === "object" && "file" in info && !!(info as { file?: unknown }).file;
    } catch { return false; }
  }

  private schedule(): void {
    this.options.controller.cancel(this.view);
    if (!this.eligible() || this.view.state.field(ghostField, false)?.suggestion) return;
    const source = this.view.state;
    const context = createCompletionContext(source.doc, source.selection.main.head);
    this.options.controller.schedule(this.view, context, outcome => {
      if (outcome.status === "completed" && outcome.text !== null && this.eligible()) {
        showGhost(this.view, source, outcome.text);
      }
    });
  }

  private cancel(): void { this.options.controller.cancel(this.view); }
}
