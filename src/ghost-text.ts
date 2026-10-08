import { EditorSelection, EditorState, Prec, StateEffect, StateField, Transaction } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { Decoration, DecorationSet, EditorView, keymap, WidgetType } from "@codemirror/view";

interface Suggestion { readonly at: number; readonly text: string }
interface GhostState { readonly suggestion: Suggestion | null; readonly decorations: DecorationSet }
const empty: GhostState = { suggestion: null, decorations: Decoration.none };
const show = StateEffect.define<{ source: EditorState; text: string }>();
const remaining = StateEffect.define<{ source: EditorState; doc: EditorState["doc"]; suggestion: Suggestion }>();
const dismiss = StateEffect.define<null>();

class GhostWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(other: GhostWidget): boolean { return other.text === this.text; }
  get lineBreaks(): number { return this.text.split("\n").length - 1; }
  toDOM(view: EditorView): HTMLElement {
    const span = view.dom.ownerDocument.createElement("span");
    span.className = "inline-suggestions-ghost";
    span.setAttribute("aria-hidden", "true");
    span.textContent = this.text;
    return span;
  }
  ignoreEvent(): boolean { return true; }
}

function render(suggestion: Suggestion | null): GhostState {
  if (!suggestion?.text) return empty;
  return { suggestion, decorations: Decoration.set([
    Decoration.widget({ widget: new GhostWidget(suggestion.text), side: 1 }).range(suggestion.at),
  ]) };
}

export const ghostField = StateField.define<GhostState>({
  create: () => empty,
  update(value, tr) {
    // Never map a proposal onto edited content: conservative invalidation is safer.
    let suggestion = tr.docChanged || tr.selection ? null : value.suggestion;
    for (const effect of tr.effects) {
      if (effect.is(dismiss)) suggestion = null;
      if (effect.is(show) && effect.value.source === tr.startState && !tr.docChanged && !tr.selection) {
        const selection = tr.state.selection;
        if (selection.ranges.length === 1 && selection.main.empty) {
          const text = effect.value.text.replace(/\r\n?/g, "\n");
          // Bound widget layout work, even if a future provider misbehaves.
          const safePlacement = !text.includes("\n") ||
            tr.state.doc.lineAt(selection.main.head).to === selection.main.head;
          suggestion = safePlacement && text.length > 0 && text.length <= 10000
            ? { at: selection.main.head, text } : null;
        }
      }
      if (effect.is(remaining) && effect.value.source === tr.startState &&
          effect.value.doc.eq(tr.newDoc)) suggestion = effect.value.suggestion;
    }
    if (tr.state.readOnly || (suggestion && (tr.state.selection.ranges.length !== 1 ||
        !tr.state.selection.main.empty || tr.state.selection.main.head !== suggestion.at))) suggestion = null;
    return suggestion === value.suggestion ? value : render(suggestion);
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
});

/** Snapshot must be captured before requesting text; any intervening transaction invalidates it. */
export function showGhost(view: EditorView, source: EditorState, text: string): boolean {
  if (view.compositionStarted || !view.hasFocus || view.state.readOnly || view.state !== source ||
      !view.state.field(ghostField, false)) return false;
  view.dispatch({ effects: show.of({ source, text }) });
  return !!view.state.field(ghostField).suggestion;
}

export function dismissGhost(view: EditorView): boolean {
  if (!view.state.field(ghostField, false)?.suggestion) return false;
  view.dispatch({ effects: dismiss.of(null) });
  return true;
}

export function nextWordLength(text: string): number {
  // Keep leading whitespace with the next word; punctuation stays attached.
  return /^\s*\S+\s*/u.exec(text)?.[0].length ?? text.length;
}

export function acceptGhost(view: EditorView, word = false): boolean {
  const suggestion = view.state.field(ghostField, false)?.suggestion;
  const selection = view.state.selection;
  if (!suggestion || view.compositionStarted || view.state.readOnly || !view.hasFocus ||
      selection.ranges.length !== 1 || !selection.main.empty || selection.main.head !== suggestion.at) return false;
  const length = word ? nextWordLength(suggestion.text) : suggestion.text.length;
  const inserted = suggestion.text.slice(0, length);
  const at = suggestion.at + inserted.length;
  const changes = view.state.changes({ from: suggestion.at, insert: inserted });
  view.dispatch({
    changes,
    selection: EditorSelection.cursor(at),
    effects: remaining.of({ source: view.state, doc: changes.apply(view.state.doc),
      suggestion: { at, text: suggestion.text.slice(length) } }),
    annotations: [Transaction.userEvent.of("input.complete"), isolateHistory.of("full")],
    scrollIntoView: true,
  });
  return true;
}

export const ghostTextExtension = [
  ghostField,
  EditorView.baseTheme({
    ".inline-suggestions-ghost": {
      opacity: "0.45", whiteSpace: "pre-wrap", pointerEvents: "none", userSelect: "none",
    },
  }),
  Prec.high(keymap.of([
    { key: "Tab", run: view => acceptGhost(view) },
    { key: "Mod-ArrowRight", run: view => acceptGhost(view, true) },
    { key: "Escape", run: dismissGhost },
  ])),
  EditorView.domEventHandlers({
    blur: (_event, view) => { dismissGhost(view); },
    compositionstart: (_event, view) => { dismissGhost(view); },
    mousedown: (_event, view) => { dismissGhost(view); },
  }),
];
