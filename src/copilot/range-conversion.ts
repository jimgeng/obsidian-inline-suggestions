import { CompletionContext } from "../completion-provider";
import { validateSuggestion } from "../suggestion";

export interface Position { line: number; character: number }
export interface CompletionRange { start: Position; end: Position }

export const normalizeNewlines = (text: string): string => text.replace(/\r\n?/g, "\n");

export function positionAt(text: string, offset: number): Position {
  const lines = text.slice(0, offset).split("\n");
  return { line: lines.length - 1, character: lines[lines.length - 1]!.length };
}

function offsetAt(text: string, position: Position): number | null {
  if (!position || !Number.isInteger(position.line) || !Number.isInteger(position.character)
    || position.line < 0 || position.character < 0) return null;
  const lines = text.split("\n");
  const line = lines[position.line];
  if (line === undefined || position.character > line.length) return null;
  const offset = lines.slice(0, position.line).reduce((sum, value) => sum + value.length + 1, 0) + position.character;
  // LSP uses UTF-16 offsets, but a replacement must not split a code point.
  if (offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset] ?? "")) return null;
  return offset;
}

/** Preserve replacement semantics using insertion only; never guess at suffix overlap. */
export function insertionFromCompletion(context: CompletionContext, item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const { insertText, range } = item as { insertText?: unknown; range?: CompletionRange };
  if (typeof insertText !== "string" || !range) return null;
  const prefix = normalizeNewlines(context.prefix);
  const suffix = normalizeNewlines(context.suffix);
  const document = prefix + suffix;
  const start = offsetAt(document, range.start);
  const end = offsetAt(document, range.end);
  if (start === null || end === null || start > prefix.length || end < prefix.length) return null;
  let text = normalizeNewlines(insertText);
  const before = document.slice(start, prefix.length);
  const after = document.slice(prefix.length, end);
  if (!text.startsWith(before)) return null;
  text = text.slice(before.length);
  if (after) {
    if (!text.endsWith(after)) return null;
    text = text.slice(0, -after.length);
  }
  // An un-ranged suffix echo is not useful; partial/unproven overlaps stay unchanged.
  if (suffix && text === suffix) return null;
  const lineEnd = suffix.indexOf("\n");
  return validateSuggestion(text, prefix.length, prefix.length + (lineEnd < 0 ? suffix.length : lineEnd))?.text ?? null;
}
