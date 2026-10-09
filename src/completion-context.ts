import { CompletionContext } from "./completion-provider";

export const MAX_PREFIX_LENGTH = 8_000;
export const MAX_SUFFIX_LENGTH = 2_000;

/** Minimal document interface implemented by CodeMirror's Text type. */
export interface SliceableDocument {
  readonly length: number;
  sliceString(from: number, to?: number): string;
}

/** Clip a range without leaving half of a UTF-16 surrogate pair at either edge. */
function safeSlice(doc: SliceableDocument, from: number, to: number): string {
  let start = from;
  let end = to;
  if (start > 0 && start < doc.length) {
    const current = doc.sliceString(start, start + 1).charCodeAt(0);
    const previous = doc.sliceString(start - 1, start).charCodeAt(0);
    if (current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) start++;
  }
  if (end > 0 && end < doc.length) {
    const previous = doc.sliceString(end - 1, end).charCodeAt(0);
    const current = doc.sliceString(end, end + 1).charCodeAt(0);
    if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) end--;
  }
  return doc.sliceString(start, end);
}

/** Extract only the bounded prefix and suffix ranges around a document offset. */
export function createCompletionContext(
  doc: SliceableDocument,
  position: number,
  prefixLimit = MAX_PREFIX_LENGTH,
  suffixLimit = MAX_SUFFIX_LENGTH,
): CompletionContext {
  if (!Number.isInteger(position) || position < 0 || position > doc.length) {
    throw new RangeError("Completion position is outside the document");
  }
  if (!Number.isInteger(prefixLimit) || prefixLimit < 0 || !Number.isInteger(suffixLimit) || suffixLimit < 0) {
    throw new RangeError("Completion context limits must be non-negative integers");
  }
  let prefixEnd = position;
  let suffixStart = position;
  if (position > 0 && position < doc.length) {
    const previous = doc.sliceString(position - 1, position).charCodeAt(0);
    const current = doc.sliceString(position, position + 1).charCodeAt(0);
    if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) {
      prefixEnd--;
      suffixStart++;
    }
  }
  return {
    prefix: safeSlice(doc, Math.max(0, prefixEnd - prefixLimit), prefixEnd),
    suffix: safeSlice(doc, suffixStart, Math.min(doc.length, suffixStart + suffixLimit)),
  };
}
