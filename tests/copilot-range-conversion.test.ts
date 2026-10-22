import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "mocha";
import { insertionFromCompletion, positionAt, normalizeNewlines } from "../src/copilot/range-conversion";

function convert(prefix: string, suffix: string, insertText: string, start = prefix.length, end = prefix.length) {
  const document = normalizeNewlines(prefix + suffix);
  return insertionFromCompletion({ prefix, suffix }, { insertText, range: { start: positionAt(document, start), end: positionAt(document, end) } });
}

describe("Copilot insertion-only conversion", () => {
  for (const [name, expected] of [["range-before-cursor", "something important."], ["range-at-cursor", "- 2 cups of flour"]]) {
    it(`converts captured ${name} fixture`, () => {
      const fixture = JSON.parse(readFileSync(`tests/fixtures/copilot/${name}.json`, "utf8"));
      const position = fixture.request.position;
      const lines = fixture.document.split("\n");
      const at = lines.slice(0, position.line).join("\n").length + (position.line ? 1 : 0) + position.character;
      assert.equal(insertionFromCompletion({ prefix: fixture.document.slice(0, at), suffix: fixture.document.slice(at) }, fixture.response.items[0]), expected);
    });
  }
  const cases: [string, string, string, string, string | null, number?, number?][] = [
    ["heading", "# ", "", "A heading", "A heading"],
    ["list prefix", "- a", "", "- another item", "nother item", 0],
    ["prefix mismatch", "- a", "", "- different", null, 0],
    ["multiline", "hello", "", " there\nnext", " there\nnext"],
    ["fences", "", "", "```ts\n  x\n```", "```ts\n  x\n```"],
    ["indentation", "", "", "    code", "    code"],
    ["hard break", "text", "", "  \nnext", "  \nnext"],
    ["whitespace policy", "", "", "  ", "  "],
    ["ranged suffix", "a", "bc", "x bc", "x ", 1, 3],
    ["suffix mismatch", "a", "bc", "x bd", null, 1, 3],
    ["repeated delimiters", "**a", "**", "bc**", "bc", 3, 5],
    ["unproven delimiter overlap", "**a", "**", "bc**", "bc**"],
    ["no overlap", "a", "bc", "xy", "xy"],
    ["suffix only", "a", "bc", "bc", null],
    ["ranged suffix only", "a", "bc", "bc", null, 1, 3],
    ["empty", "", "", "", null],
    ["mid-line multiline", "a", "b", "x\ny", null],
    ["line-end multiline", "a", "\nb", "x\ny", "x\ny"],
    ["CRLF", "a\r\n", "", "b\r\nc\rd", "b\nc\nd"],
    ["Unicode", "😀 café ", "", "😀 café 世界", "世界", 0],
    ["size limit", "", "", "x".repeat(10001), null],
  ];
  for (const [name, prefix, suffix, text, expected, start, end] of cases) {
    it(name, () => assert.equal(convert(prefix, suffix, text, start, end), expected));
  }
  it("rejects malformed or non-insertion ranges and snippets", () => {
    for (const item of [null, {}, { insertText: { value: "x" } },
      { insertText: "x", range: { start: { line: 0, character: 3 }, end: { line: 0, character: 3 } } },
      { insertText: "x", range: { start: { line: 0, character: 0 }, end: { line: 8, character: 0 } } },
      { insertText: "x", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
      { insertText: "x", range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } } },
    ]) assert.equal(insertionFromCompletion({ prefix: "😀", suffix: "" }, item), null);
  });
});
