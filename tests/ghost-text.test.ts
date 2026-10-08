import { strict as assert } from "node:assert";
import { after, afterEach, before, describe, it } from "mocha";
import { JSDOM } from "jsdom";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo, redo } from "@codemirror/commands";
import { acceptGhost, dismissGhost, ghostField, ghostTextExtension, showGhost } from "../src/ghost-text";

describe("ghost text editor slice", () => {
  let dom: JSDOM;
  let view: EditorView;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  before(() => {
    dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
    // jsdom has no layout engine; these tests validate transactions/DOM, not geometry.
    dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
    const globals: Record<string, unknown> = {
      window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
      MutationObserver: dom.window.MutationObserver, HTMLElement: dom.window.HTMLElement,
      Node: dom.window.Node, Window: dom.window.Window,
      requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
      cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    };
    for (const [key, value] of Object.entries(globals)) {
      saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
  });
  afterEach(() => { view?.destroy(); dom.window.document.body.replaceChildren(); });
  after(() => {
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  function create(extra: Parameters<typeof EditorState.create>[0] = {}) {
    view = new EditorView({
      state: EditorState.create({ doc: "hello", selection: { anchor: 5 },
        ...extra, extensions: [extra.extensions ?? [ghostTextExtension, history()],
          EditorView.exceptionSink.of(error => { throw error; })] }),
      parent: dom.window.document.body,
    });
    view.focus();
    return view;
  }
  const text = () => view.state.doc.toString();
  const ghost = () => view.state.field(ghostField).suggestion;

  it("renders literal multiline text without modifying the document", () => {
    create();
    assert.equal(showGhost(view, view.state, " <b>world</b>\nnext"), true);
    assert.equal(text(), "hello");
    const widget = view.dom.querySelector(".inline-suggestions-ghost")!;
    assert.equal(widget.textContent, " <b>world</b>\nnext");
    assert.equal(widget.querySelector("b"), null);
    assert.equal(undo(view), false);
  });
  it("accepts fully as one isolated undo step, without resurrecting ghosts", () => {
    create();
    view.dispatch({ changes: { from: 5, insert: "!" }, selection: { anchor: 6 } });
    showGhost(view, view.state, " world\nnext");
    assert.equal(acceptGhost(view), true);
    assert.equal(text(), "hello! world\nnext");
    assert.equal(ghost(), null);
    assert.equal(undo(view), true);
    assert.equal(text(), "hello!");
    assert.equal(ghost(), null);
    assert.equal(redo(view), true);
    assert.equal(text(), "hello! world\nnext");
  });
  it("accepts words and retains the remainder at the new cursor", () => {
    create();
    showGhost(view, view.state, " brave new world");
    assert.equal(acceptGhost(view, true), true);
    assert.equal(text(), "hello brave ");
    assert.deepEqual(ghost(), { at: 12, text: "new world" });
    acceptGhost(view, true);
    assert.equal(text(), "hello brave new ");
    undo(view);
    assert.equal(text(), "hello brave ");
    assert.equal(ghost(), null);
  });
  it("dismisses without changing text or history", () => {
    create(); showGhost(view, view.state, " world");
    assert.equal(dismissGhost(view), true);
    assert.equal(dismissGhost(view), false);
    assert.equal(acceptGhost(view), false);
    assert.equal(text(), "hello");
    assert.equal(undo(view), false);
  });
  it("invalidates on edits anywhere and explicit selection transactions", () => {
    create(); showGhost(view, view.state, " world");
    view.dispatch({ changes: { from: 0, insert: "x" } });
    assert.equal(ghost(), null);
    showGhost(view, view.state, " world");
    view.dispatch({ selection: view.state.selection });
    assert.equal(ghost(), null);
  });
  it("rejects stale snapshots even after a selection-only transaction", () => {
    create(); const snapshot = view.state;
    view.dispatch({ selection: { anchor: 0 } });
    assert.equal(showGhost(view, snapshot, " stale"), false);
    assert.equal(ghost(), null);
  });
  it("does not show for ranges, multiple cursors, read-only or oversized content", () => {
    create();
    view.dispatch({ selection: { anchor: 0, head: 3 } });
    assert.equal(showGhost(view, view.state, "no"), false);
    view.dispatch({ selection: EditorSelection.cursor(5) });
    assert.equal(showGhost(view, view.state, "x".repeat(10001)), false);
    view.destroy();
    create({ extensions: [ghostTextExtension, EditorState.allowMultipleSelections.of(true)],
      selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(5)]) });
    assert.equal(showGhost(view, view.state, "no"), false);
    view.destroy();
    create({ extensions: [ghostTextExtension, EditorState.readOnly.of(true)] });
    assert.equal(showGhost(view, view.state, "no"), false);
  });
  it("limits multiline previews to line ends and reports explicit line breaks", () => {
    create();
    view.dispatch({ selection: { anchor: 2 } });
    assert.equal(showGhost(view, view.state, "one\ntwo"), false);
    assert.equal(showGhost(view, view.state, "one"), true);
    view.dispatch({ selection: { anchor: 5 } });
    showGhost(view, view.state, "one\r\ntwo\rthree");
    assert.equal(ghost()?.text, "one\ntwo\nthree");
    const decorations = view.state.field(ghostField).decorations;
    assert.equal(decorations.iter().value?.spec.widget.lineBreaks, 2);
  });
  it("blocks display and acceptance throughout composition, before text changes", () => {
    create(); showGhost(view, view.state, " world");
    Object.defineProperty(view, "compositionStarted", { configurable: true, value: true });
    assert.equal(acceptGhost(view), false);
    assert.equal(showGhost(view, view.state, " replacement"), false);
    assert.equal(text(), "hello");
  });
  it("clears before composition and on blur", () => {
    create(); showGhost(view, view.state, " world");
    view.contentDOM.dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true }));
    assert.equal(ghost(), null);
    assert.equal(acceptGhost(view), false);
    view.contentDOM.dispatchEvent(new dom.window.CompositionEvent("compositionend", { bubbles: true }));
    view.destroy(); create(); showGhost(view, view.state, " world");
    view.contentDOM.blur();
    assert.equal(ghost(), null);
  });
  it("removes widgets on extension teardown without touching content", () => {
    const compartment = new Compartment();
    create({ extensions: [compartment.of(ghostTextExtension)] });
    showGhost(view, view.state, " world");
    view.dispatch({ effects: compartment.reconfigure([]) });
    assert.equal(view.dom.querySelector(".inline-suggestions-ghost"), null);
    assert.equal(text(), "hello");
    assert.equal(acceptGhost(view), false);
  });
  it("clears when an editor becomes read-only", () => {
    const readonly = new Compartment();
    create({ extensions: [ghostTextExtension, readonly.of(EditorState.readOnly.of(false))] });
    showGhost(view, view.state, " world");
    view.dispatch({ effects: readonly.reconfigure(EditorState.readOnly.of(true)) });
    assert.equal(ghost(), null);
    assert.equal(acceptGhost(view), false);
  });
  it("drops the remainder if another extension filters the accepted insertion", () => {
    create({ extensions: [ghostTextExtension, EditorState.changeFilter.of(() => false)] });
    showGhost(view, view.state, " one two");
    acceptGhost(view, true);
    assert.equal(text(), "hello");
    assert.equal(ghost(), null);
  });
  it("survives repeated preview/partial acceptance/undo cycles", () => {
    create();
    for (let i = 0; i < 100; i++) {
      assert.equal(showGhost(view, view.state, " one two\nthree"), true);
      assert.equal(acceptGhost(view, true), true);
      assert.equal(acceptGhost(view), true);
      assert.equal(undo(view), true);
      assert.equal(undo(view), true);
      assert.equal(text(), "hello");
      assert.equal(ghost(), null);
    }
  });
  it("leaves Tab alone when there is no suggestion", () => {
    create();
    const event = new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
    showGhost(view, view.state, " world");
    const accept = new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(accept);
    assert.equal(accept.defaultPrevented, true);
    assert.equal(text(), "hello world");
  });
});
