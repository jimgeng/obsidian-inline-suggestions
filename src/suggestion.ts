import { EditorState } from "@codemirror/state";

export interface Suggestion { readonly at: number; readonly text: string }

/** Create a suggestion from an immutable editor snapshot, without dispatching effects. */
export function createSuggestion(state: EditorState, text: string): Suggestion | null {
  const selection = state.selection;
  if (state.readOnly || selection.ranges.length !== 1 || !selection.main.empty) return null;
  const at = selection.main.head;
  return validateSuggestion(text, at, state.doc.lineAt(at).to);
}

/** Validate provider text for an insertion point, without editor state or side effects. */
export function validateSuggestion(text: string, at: number, lineEnd: number): Suggestion | null {
  const normalized = text.replace(/\r\n?/g, "\n");
  // Bound widget layout work, even if a future provider misbehaves.
  if (normalized.length === 0 || normalized.length > 10000) return null;
  if (normalized.includes("\n") && at !== lineEnd) return null;
  return { at, text: normalized };
}
