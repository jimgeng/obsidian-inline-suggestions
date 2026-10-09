import { strict as assert } from "node:assert";
import { after, afterEach, before, describe, it } from "mocha";
import { JSDOM } from "jsdom";
import { Compartment, EditorState, StateField, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { CompletionProvider } from "../src/completion-provider";
import { createCompletionExtension, setCompletionEditorInfoField } from "../src/completion-extension";
import { ghostField, ghostTextExtension } from "../src/ghost-text";

const wait = (ms = 360) => new Promise(resolve => setTimeout(resolve, ms));
const nextTick = () => new Promise(resolve => setTimeout(resolve, 0));

describe("automatic completion extension", () => {
  let fileInfo: StateField<{ file: { path: string } }>;
  let dom: JSDOM;
  let views: EditorView[] = [];
  const saved = new Map<string, PropertyDescriptor | undefined>();
  before(() => {
    dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
    fileInfo = StateField.define({ create: () => ({ file: { path: "test.md" } }), update: value => value });
    setCompletionEditorInfoField(fileInfo);
    dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
    const globals: Record<string, unknown> = { window: dom.window, document: dom.window.document,
      navigator: dom.window.navigator, MutationObserver: dom.window.MutationObserver,
      HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, Window: dom.window.Window,
      requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
      cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) };
    for (const [key, value] of Object.entries(globals)) {
      saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
  });
  afterEach(() => { for (const view of views) view.destroy(); views = []; dom.window.document.body.replaceChildren(); });
  after(() => { dom.window.close(); for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }});

  function create(provider: CompletionProvider, includeFileInfo = true): EditorView {
    const extensions = [ghostTextExtension, createCompletionExtension(provider),
      EditorView.exceptionSink.of(error => { throw error; })];
    if (includeFileInfo) extensions.push(fileInfo);
    // Obsidian adds editorInfoField to Markdown editor views; omit it to test rejection.
    if (!includeFileInfo) setCompletionEditorInfoField(null);
    const view = new EditorView({ state: EditorState.create({ doc: "hello", selection: { anchor: 5 }, extensions: [fileInfo, ...extensions] }),
      parent: dom.window.document.body });
    views.push(view); view.focus(); return view;
  }
  const type = (view: EditorView, insert: string) => view.dispatch({ changes: { from: view.state.selection.main.head, insert },
    selection: { anchor: view.state.selection.main.head + insert.length }, annotations: Transaction.userEvent.of("input.type") });

  it("debounces ordinary typing and renders the completion for the final context", async () => {
    let calls = 0;
    const provider: CompletionProvider = { async complete(context) { calls++; assert.equal(context.prefix, "hello!?"); return " world"; } };
    const view = create(provider);
    type(view, "!");
    await wait(180);
    type(view, "?");
    await wait(380);
    assert.equal(calls, 1);
    assert.equal(view.state.field(ghostField).suggestion?.text, " world");
  });
  it("cancels on Escape even when no ghost is visible and ignores a late response", async () => {
    let resolve!: (text: string) => void;
    let signal!: AbortSignal;
    const provider: CompletionProvider = { complete: (_context, s) => { signal = s; return new Promise(r => { resolve = r; }); } };
    const view = create(provider);
    type(view, "!"); await wait(360);
    const escape = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    view.contentDOM.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(signal.aborted, true);
    resolve(" stale"); await Promise.resolve();
    assert.equal(view.state.field(ghostField).suggestion, null);
  });
  it("requests after committed IME input, but not for completion/acceptance transactions", async () => {
    let calls = 0;
    const view = create({ complete: async () => { calls++; return "x"; } });
    view.dispatch({ changes: { from: 5, insert: "語" }, selection: { anchor: 6 },
      annotations: Transaction.userEvent.of("input.type.compose") });
    await wait(350);
    assert.equal(calls, 1);
    const completionOnly = create({ complete: async () => { calls++; return "y"; } });
    completionOnly.dispatch({ changes: { from: 5, insert: "!" }, selection: { anchor: 6 },
      annotations: Transaction.userEvent.of("input.complete") });
    await wait(350);
    assert.equal(calls, 1);
  });
  it("does not request for programmatic edits or selection movement", async () => {
    let calls = 0;
    const view = create({ complete: async () => { calls++; return "x"; } });
    view.dispatch({ changes: { from: 5, insert: "!" } });
    view.dispatch({ selection: { anchor: 0 } });
    await wait(350); assert.equal(calls, 0);
  });
  it("cancels a pending request when the editor becomes read-only", async () => {
    let calls = 0;
    const readonly = new Compartment();
    const view = new EditorView({ state: EditorState.create({ doc: "hello", selection: { anchor: 5 },
      extensions: [fileInfo, ghostTextExtension, createCompletionExtension({ complete: async () => { calls++; return "x"; } }), readonly.of([])] }),
      parent: dom.window.document.body });
    views.push(view); view.focus(); type(view, "!");
    view.dispatch({ effects: readonly.reconfigure(EditorState.readOnly.of(true)) });
    await wait(350);
    assert.equal(calls, 0);
  });
  it("does not cross editor lifetimes", async () => {
    let resolve!: (text: string) => void;
    const provider: CompletionProvider = { complete: () => new Promise(r => { resolve = r; }) };
    const first = create(provider); type(first, "!"); await wait(360);
    first.destroy();
    resolve(" stale"); await Promise.resolve();
    assert.equal(first.state.field(ghostField).suggestion, null);
  });
});
