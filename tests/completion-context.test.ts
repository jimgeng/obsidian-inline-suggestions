import { strict as assert } from "node:assert";
import { describe, it } from "mocha";
import { createCompletionContext, SliceableDocument } from "../src/completion-context";

class InstrumentedDocument implements SliceableDocument {
  readonly length: number;
  readonly slices: Array<[number, number]> = [];
  constructor(private readonly text: string) { this.length = text.length; }
  sliceString(from: number, to = this.length): string {
    this.slices.push([from, to]);
    return this.text.slice(from, to);
  }
}

describe("createCompletionContext", () => {
  it("extracts only bounded ranges from large documents", () => {
    const doc = new InstrumentedDocument("a".repeat(20_000));
    const result = createCompletionContext(doc, 10_000, 8, 4);
    assert.deepEqual(result, { prefix: "a".repeat(8), suffix: "a".repeat(4) });
    assert.ok(doc.slices.every(([from, to]) => to - from <= 8));
    assert.ok(!doc.slices.some(([from, to]) => from === 0 && to === doc.length));
    assert.ok(doc.slices.some(([from, to]) => from === 9_992 && to === 10_000));
    assert.ok(doc.slices.some(([from, to]) => from === 10_000 && to === 10_004));
  });

  it("handles empty edges, multiline context, and Unicode clipping", () => {
    const doc = new InstrumentedDocument("A😀\nBC");
    assert.deepEqual(createCompletionContext(doc, 0, 8, 3), { prefix: "", suffix: "A😀" });
    assert.deepEqual(createCompletionContext(doc, doc.length, 3, 8), { prefix: "\nBC", suffix: "" });
    assert.deepEqual(createCompletionContext(doc, 3, 2, 3), { prefix: "😀", suffix: "\nBC" });
    assert.deepEqual(createCompletionContext(doc, 2, 2, 2), { prefix: "A", suffix: "\nB" });
    assert.deepEqual(createCompletionContext(new InstrumentedDocument("0123456789"), 5, 2, 2), {
      prefix: "34", suffix: "56",
    });
  });

  it("rejects invalid positions and limits", () => {
    const doc = new InstrumentedDocument("abc");
    assert.throws(() => createCompletionContext(doc, 4), RangeError);
    assert.throws(() => createCompletionContext(doc, 1, -1), RangeError);
  });
});
