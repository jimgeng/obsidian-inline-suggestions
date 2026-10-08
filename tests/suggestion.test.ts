import { strict as assert } from "node:assert";
import { describe, it } from "mocha";
import { EditorSelection, EditorState } from "@codemirror/state";
import { createSuggestion, validateSuggestion } from "../src/suggestion";

describe("suggestion creation", () => {
  it("creates a normalized suggestion at the cursor without changing state", () => {
    const state = EditorState.create({ doc: "hello", selection: { anchor: 5 } });
    assert.deepEqual(createSuggestion(state, " world\r\nnext"), { at: 5, text: " world\nnext" });
    assert.equal(state.doc.toString(), "hello");
    assert.equal(state.selection.main.head, 5);
  });
  it("rejects nonempty selections, multiple cursors, and read-only states", () => {
    const states = [
      EditorState.create({ doc: "hello", selection: { anchor: 0, head: 3 } }),
      EditorState.create({ doc: "hello",
        extensions: EditorState.allowMultipleSelections.of(true),
        selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(5)]) }),
      EditorState.create({ doc: "hello", selection: { anchor: 5 },
        extensions: EditorState.readOnly.of(true) }),
    ];
    for (const state of states) assert.equal(createSuggestion(state, " world"), null);
  });
  it("uses the cursor's line end and applies text validation", () => {
    const state = EditorState.create({ doc: "hello\nworld", selection: { anchor: 5 } });
    assert.notEqual(createSuggestion(state, "one\ntwo"), null);
    const midLine = state.update({ selection: { anchor: 2 } }).state;
    assert.equal(createSuggestion(midLine, "one\ntwo"), null);
    assert.deepEqual(createSuggestion(midLine, "one"), { at: 2, text: "one" });
    assert.equal(createSuggestion(state, ""), null);
    assert.equal(createSuggestion(state, "x".repeat(10001)), null);
  });
});

describe("suggestion validation", () => {
  it("accepts literal single-line text anywhere on a line", () => {
    assert.deepEqual(validateSuggestion(" <b>world</b>", 2, 5), {
      at: 2, text: " <b>world</b>",
    });
  });
  it("normalizes CRLF and CR line endings", () => {
    assert.deepEqual(validateSuggestion("one\r\ntwo\rthree", 5, 5), {
      at: 5, text: "one\ntwo\nthree",
    });
  });
  it("rejects multiline text away from a line end, including normalized breaks", () => {
    for (const text of ["one\ntwo", "one\r\ntwo", "one\rtwo"]) {
      assert.equal(validateSuggestion(text, 2, 5), null);
      assert.notEqual(validateSuggestion(text, 5, 5), null);
    }
  });
  it("rejects empty text but preserves whitespace-only suggestions", () => {
    assert.equal(validateSuggestion("", 5, 5), null);
    assert.deepEqual(validateSuggestion("  ", 5, 5), { at: 5, text: "  " });
  });
  it("applies the size limit after normalization", () => {
    assert.equal(validateSuggestion("x".repeat(10000), 5, 5)?.text.length, 10000);
    assert.equal(validateSuggestion("x".repeat(10001), 5, 5), null);
    assert.equal(validateSuggestion("\r\n".repeat(10000), 5, 5)?.text.length, 10000);
    assert.equal(validateSuggestion("\r\n".repeat(10001), 5, 5), null);
  });
});
