import { strict as assert } from "node:assert";
import { after, afterEach, before, describe, it } from "mocha";
import { JSDOM } from "jsdom";
import { Compartment, EditorSelection, EditorState, Extension, StateEffect, StateField, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { CompletionProvider } from "../src/completion-provider";
import { PluginSettingsStore } from "../src/plugin-settings";
import { createCompletionExtension, createCompletionIntegration } from "../src/completion-extension";
import { acceptGhost, dismissGhost, ghostField, ghostTextExtension, showGhost } from "../src/ghost-text";

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

  const isMarkdownEditor = (view: EditorView) => view.state.field(fileInfo, false)?.file.path.toLowerCase().endsWith(".md") === true;

  function create(provider: CompletionProvider, includeFileInfo = true, completion?: Extension): EditorView {
    const extensions = [ghostTextExtension, completion ?? createCompletionExtension(provider, isMarkdownEditor),
      EditorView.exceptionSink.of(error => { throw error; })];
    if (includeFileInfo) extensions.push(fileInfo);
    // Obsidian adds editorInfoField to Markdown editor views; omit it to test rejection.
    const view = new EditorView({ state: EditorState.create({ doc: "hello", selection: { anchor: 5 }, extensions }),
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
  it("reuses matching typing without requests, including full consumption, then requests on new input", async () => {
    let calls = 0;
    const view = create({ complete: async () => { calls++; return "a😀\nend"; } });
    type(view, "!"); await wait(); assert.equal(calls, 1);
    type(view, "a");
    assert.deepEqual(view.state.field(ghostField).suggestion, { at: 7, text: "😀\nend" });
    await wait(); assert.equal(calls, 1);
    type(view, "😀\n");
    assert.deepEqual(view.state.field(ghostField).suggestion, { at: 10, text: "end" });
    type(view, "end"); assert.equal(view.state.field(ghostField).suggestion, null);
    await wait(); assert.equal(calls, 1);
    type(view, "?"); await wait(); assert.equal(calls, 2);
  });
  it("invalidates a mismatch and requests a fresh completion only when eligible", async () => {
    let calls = 0;
    const view = create({ complete: async () => { calls++; return "abc"; } });
    showGhost(view, view.state, "abc"); type(view, "z");
    assert.equal(view.state.field(ghostField).suggestion, null);
    await wait(); assert.equal(calls, 1);
    type(view, "z"); view.dispatch({ selection: { anchor: 0 } });
    await wait(); assert.equal(calls, 1);
  });
  it("does not rebase in-flight results even when later typing matches their prefix", async () => {
    const requests: { resolve: (text: string) => void; signal: AbortSignal }[] = [];
    const view = create({ complete: (_context, signal) => new Promise<string>(resolve => requests.push({ resolve, signal })) });
    type(view, "!"); await wait();
    type(view, "a"); assert.equal(requests[0]!.signal.aborted, true);
    requests[0]!.resolve("abc"); await nextTick();
    assert.equal(view.state.field(ghostField).suggestion, null);
    await wait(); requests[1]!.resolve("fresh"); await nextTick();
    assert.equal(view.state.field(ghostField).suggestion?.text, "fresh");
  });
  for (const event of [undefined, "input.paste", "undo", "redo"]) {
    it(`does not request after invalidating a matching ${event ?? "programmatic"} edit`, async () => {
      let calls = 0;
      const view = create({ complete: async () => { calls++; return "abc"; } });
      showGhost(view, view.state, "abc");
      view.dispatch({ changes: { from: 5, insert: "a" }, selection: { anchor: 6 },
        annotations: event ? Transaction.userEvent.of(event) : [] });
      assert.equal(view.state.field(ghostField).suggestion, null);
      await wait(); assert.equal(calls, 0);
    });
  }
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
      extensions: [fileInfo, ghostTextExtension, createCompletionExtension({ complete: async () => { calls++; return "x"; } }, isMarkdownEditor), readonly.of([])] }),
      parent: dom.window.document.body });
    views.push(view); view.focus(); type(view, "!");
    view.dispatch({ effects: readonly.reconfigure(EditorState.readOnly.of(true)) });
    await wait(350);
    assert.equal(calls, 0);
  });
  it("isolates simultaneous editors and closes each provider only once", async () => {
    const requests: { signal: AbortSignal; resolve: (text: string) => void }[] = [];
    let closed = 0;
    const integration = createCompletionIntegration(() => ({
      complete: (_context, signal) => new Promise<string>(resolve => requests.push({ signal, resolve })),
      close: async () => { closed++; },
    }), isMarkdownEditor);
    const unused = { complete: async () => null };
    const first = create(unused, true, integration.extension);
    const second = create(unused, true, integration.extension);
    // Model independent eligible editor owners without browser focus switching.
    for (const view of [first, second]) Object.defineProperty(view, "hasFocus", { get: () => true });
    type(first, "!"); type(second, "?"); await wait();
    assert.equal(requests.length, 2);
    assert.equal(requests[0]!.signal.aborted, false);
    assert.equal(requests[1]!.signal.aborted, false);
    first.dispatch({ selection: { anchor: 0 } });
    assert.equal(requests[0]!.signal.aborted, true);
    assert.equal(requests[1]!.signal.aborted, false);
    requests[0]!.resolve(" stale"); requests[1]!.resolve(" valid"); await nextTick();
    assert.equal(first.state.field(ghostField).suggestion, null);
    assert.equal(second.state.field(ghostField).suggestion?.text, " valid");
    integration.dispose(); first.destroy(); second.destroy();
    assert.equal(closed, 2);
  });

  it("keeps eligibility dependencies local to each integration", async () => {
    let allowedCalls = 0, blockedCalls = 0;
    const allowed = createCompletionIntegration(() => ({ complete: async () => { allowedCalls++; return "yes"; } }), isMarkdownEditor);
    const blocked = createCompletionIntegration(() => ({ complete: async () => { blockedCalls++; return "no"; } }), () => false);
    const first = create({ complete: async () => null }, true, allowed.extension);
    const second = create({ complete: async () => null }, true, blocked.extension);
    for (const view of [first, second]) Object.defineProperty(view, "hasFocus", { get: () => true });
    type(first, "!"); type(second, "!");
    await wait();
    assert.equal(allowedCalls, 1);
    assert.equal(blockedCalls, 0);
    allowed.dispose(); blocked.dispose();
  });

  it("rejects non-Markdown hosts and multiple/nonempty selections", async () => {
    let calls = 0;
    const provider = { complete: async () => { calls++; return "x"; } };
    const view = create(provider, false);
    type(view, "!"); await wait(); assert.equal(calls, 0);
    const markdown = create(provider);
    type(markdown, "!"); markdown.dispatch({ selection: { anchor: 0, head: 2 } });
    await wait(); assert.equal(calls, 0);
    markdown.dispatch({ selection: { anchor: markdown.state.doc.length },
      effects: StateEffect.appendConfig.of(EditorState.allowMultipleSelections.of(true)) });
    type(markdown, "?");
    markdown.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(2)]) });
    await wait(); assert.equal(calls, 0);
  });

  it("gates unavailable/signed-out work and invalidates every pane on sign-out", async () => {
    let enabled = false;
    const requests: { signal: AbortSignal; resolve: (text: string) => void }[] = [];
    let opened = 0, closed = 0;
    const integration = createCompletionIntegration(() => {
      opened++;
      return { complete: (_context, signal) => new Promise<string>(resolve => requests.push({ signal, resolve })),
        close: async () => { closed++; } };
    }, isMarkdownEditor, () => enabled);
    const unused = { complete: async () => { throw new Error("unexpected fallback"); } };
    const first = create(unused, true, integration.extension);
    type(first, "!"); await wait(); assert.equal(requests.length, 0);
    enabled = true;
    type(first, "?"); await wait();
    const second = create(unused, true, integration.extension);
    type(second, "!"); await wait();
    assert.equal(opened, 2);
    assert.equal(requests.length, 2);
    enabled = false;
    integration.invalidate();
    for (const request of requests) { assert.equal(request.signal.aborted, true); request.resolve(" stale"); }
    await nextTick();
    for (const view of [first, second]) assert.equal(view.state.field(ghostField).suggestion, null);
    type(second, "?"); await wait(); assert.equal(requests.length, 2);
    enabled = true;
    type(second, "."); await wait();
    requests[2]!.resolve(" visible"); await nextTick();
    assert.ok(second.state.field(ghostField).suggestion);
    enabled = false; integration.invalidate();
    assert.equal(second.state.field(ghostField).suggestion, null);
    integration.dispose(); assert.equal(closed, 2);
  });

  it("immediately cancels debounce/in-flight work and visible ghosts when the preference turns off", async () => {
    const settings = new PluginSettingsStore({}, async () => {}, error => { throw error; });
    const requests: { signal: AbortSignal; resolve: (text: string) => void }[] = [];
    const integration = createCompletionIntegration(() => ({
      complete: (_context, signal) => new Promise<string>(resolve => requests.push({ signal, resolve })),
    }), isMarkdownEditor, () => settings.current.automaticSuggestions);
    const unsubscribe = settings.subscribe(() => { if (!settings.current.automaticSuggestions) integration.invalidate(); });
    const unused = { complete: async () => null };
    const first = create(unused, true, integration.extension);
    const second = create(unused, true, integration.extension);
    for (const view of [first, second]) Object.defineProperty(view, "hasFocus", { get: () => true });
    type(first, "!");
    await wait();
    type(second, "?"); // Still debouncing when disabled.
    void settings.setAutomaticSuggestions(false);
    assert.equal(requests[0]!.signal.aborted, true);
    requests[0]!.resolve(" stale");
    await wait();
    assert.equal(requests.length, 1);
    for (const view of [first, second]) assert.equal(view.state.field(ghostField).suggestion, null);
    type(first, "?");
    await wait();
    assert.equal(requests.length, 1);
    await settings.setAutomaticSuggestions(true);
    await wait();
    assert.equal(requests.length, 1); // Enabling waits for new typing.
    type(first, ".");
    await wait();
    requests[1]!.resolve(" visible");
    await nextTick();
    assert.ok(first.state.field(ghostField).suggestion);
    void settings.setAutomaticSuggestions(false);
    assert.equal(first.state.field(ghostField).suggestion, null);
    unsubscribe(); integration.dispose();
  });

  for (const action of ["blur", "composition", "read-only", "note", "dismiss", "teardown"] as const) {
    it(`cancels in-flight work on ${action} and rejects cancellation-ignoring results`, async () => {
      let resolve!: (text: string) => void;
      let signal!: AbortSignal;
      const provider: CompletionProvider = { complete: (_context, s) => {
        signal = s; return new Promise(r => { resolve = r; });
      } };
      const integration = createCompletionIntegration(() => provider, isMarkdownEditor);
      const view = create(provider, true, integration.extension);
      type(view, "!"); await wait();
      if (action === "blur") { view.contentDOM.blur(); view.focus(); }
      if (action === "composition") {
        view.contentDOM.dispatchEvent(new dom.window.CompositionEvent("compositionstart"));
        view.contentDOM.dispatchEvent(new dom.window.CompositionEvent("compositionend"));
      }
      if (action === "read-only") view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
      if (action === "note") view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "another note" } });
      if (action === "dismiss") assert.equal(integration.dismiss(view), true);
      if (action === "teardown") integration.dispose();
      assert.equal(signal.aborted, true);
      resolve(" stale"); await nextTick();
      assert.equal(view.state.field(ghostField).suggestion, null);
      if (action === "blur" || action === "composition") {
        await wait(); assert.equal(view.state.field(ghostField).suggestion, null);
      }
      integration.dispose();
    });
  }

  it("does not loop on show effects, partial/full acceptance, dismissal or undo", async () => {
    let calls = 0;
    const view = create({ complete: async () => { calls++; return " next words"; } });
    type(view, "!"); await wait();
    assert.equal(calls, 1);
    assert.equal(acceptGhost(view, true), true);
    await wait(); assert.equal(calls, 1);
    assert.equal(view.state.field(ghostField).suggestion?.text, "words");
    assert.equal(acceptGhost(view), true);
    view.dispatch({ changes: { from: 0, insert: "x" }, annotations: Transaction.userEvent.of("undo") });
    await wait(); assert.equal(calls, 1);
    showGhost(view, view.state, " demo"); dismissGhost(view);
    await wait(); assert.equal(calls, 1);
  });

  it("shares demo cancellation with automatic work, Escape and plugin teardown", async () => {
    const integration = createCompletionIntegration(() => ({ complete: async () => " real" }), isMarkdownEditor);
    const view = create({ complete: async () => null }, true, integration.extension);
    const requests: { signal: AbortSignal; resolve: (text: string) => void }[] = [];
    const demo: CompletionProvider = { complete: (_context, signal) => new Promise<string>(resolve => requests.push({ signal, resolve })) };
    const pending = integration.preview(view, demo);
    type(view, "!"); await wait();
    assert.equal(requests[0]!.signal.aborted, true);
    requests[0]!.resolve(" fake"); await pending;
    assert.equal(view.state.field(ghostField).suggestion?.text, " real");
    dismissGhost(view);
    const escaped = integration.preview(view, demo);
    view.contentDOM.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(requests[1]!.signal.aborted, true);
    requests[1]!.resolve(" fake"); await escaped;
    const unloaded = integration.preview(view, demo);
    integration.dispose();
    assert.equal(requests[2]!.signal.aborted, true);
    requests[2]!.resolve(" fake"); await unloaded;
    assert.equal(view.state.field(ghostField).suggestion, null);
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
