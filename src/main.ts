import { apiVersion, Editor, FileSystemAdapter, Notice, Plugin } from "obsidian";
import { CopilotServerManager } from "./copilot/server-manager";
import { CopilotAuth } from "./copilot/auth";
import { CopilotSignInModal } from "./copilot/auth-modal";
import { NodePathSettingTab } from "./settings";
import { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { acceptGhost, dismissGhost, ghostTextExtension, showGhost } from "./ghost-text";
import { createCompletionExtension, setCompletionEditorInfoField } from "./completion-extension";
import { CompletionProvider } from "./completion-provider";
import { FakeCompletionProvider } from "./fake-provider";

// Obsidian exposes CM6 here at runtime, but not in its public Editor typings.
// Feature-detect it and keep this host-specific bridge out of the editor slice.
function codeMirror(editor: Editor): EditorView | undefined {
  const cm = (editor as Editor & { cm?: EditorView }).cm;
  return cm && typeof cm.dispatch === "function" && cm.state ? cm : undefined;
}

export default class InlineSuggestionsPlugin extends Plugin {
  completionProvider: CompletionProvider = new FakeCompletionProvider();
  private readonly demoRequests = new WeakMap<EditorView, AbortController>();
  private readonly activeDemoRequests = new Set<AbortController>();

  private server?: CopilotServerManager;
  private unloaded = false;

  async onload(): Promise<void> {
    this.register(() => {
      this.unloaded = true;
      void this.server?.stop();
    });
    this.register(() => {
      for (const request of this.activeDemoRequests) request.abort();
      this.activeDemoRequests.clear();
    });
    setCompletionEditorInfoField(editorInfoField);
    this.registerEditorExtension(ghostTextExtension);
    this.registerEditorExtension(createCompletionExtension(this.completionProvider));
    this.addCommand({
      id: "preview-ghost-text",
      name: "Preview ghost text (demo)",
      editorCallback: async editor => {
        const view = codeMirror(editor);
        if (!view) return;
        this.demoRequests.get(view)?.abort();
        const request = new AbortController();
        this.demoRequests.set(view, request);
        this.activeDemoRequests.add(request);
        const cancel = () => request.abort();
        view.contentDOM.addEventListener("blur", cancel, { once: true });
        view.contentDOM.addEventListener("mousedown", cancel, { once: true });
        view.contentDOM.addEventListener("compositionstart", cancel, { once: true });
        const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
        view.contentDOM.addEventListener("keydown", onKeyDown);
        view.focus();
        const source = view.state;
        const selection = source.selection;
        if (source.readOnly || selection.ranges.length !== 1 || !selection.main.empty) return;
        const at = selection.main.head;
        try {
          const text = await this.completionProvider.complete({
            prefix: source.doc.sliceString(0, at),
            suffix: source.doc.sliceString(at),
          }, request.signal);
          if (!request.signal.aborted && this.demoRequests.get(view) === request && text !== null) {
            showGhost(view, source, text);
          }
        } catch {
          // Provider failures must not interfere with normal editing.
        } finally {
          this.activeDemoRequests.delete(request);
          view.contentDOM.removeEventListener("blur", cancel);
          view.contentDOM.removeEventListener("mousedown", cancel);
          view.contentDOM.removeEventListener("compositionstart", cancel);
          view.contentDOM.removeEventListener("keydown", onKeyDown);
          if (this.demoRequests.get(view) === request) this.demoRequests.delete(view);
        }
      },
    });
    this.addCommand({
      id: "accept-ghost-text", name: "Accept suggestion",
      editorCallback: editor => {
        const view = codeMirror(editor);
        if (view) { view.focus(); acceptGhost(view); }
      },
    });
    this.addCommand({
      id: "accept-ghost-word", name: "Accept next suggested word",
      editorCallback: editor => {
        const view = codeMirror(editor);
        if (view) { view.focus(); acceptGhost(view, true); }
      },
    });
    this.addCommand({
      id: "dismiss-ghost-text", name: "Dismiss suggestion",
      editorCallback: editor => {
        const view = codeMirror(editor);
        if (view) dismissGhost(view);
      },
    });

    const data: unknown = await this.loadData();
    if (this.unloaded) return;
    const nodePath = data && typeof data === "object" && "nodePath" in data && typeof data.nodePath === "string"
      ? data.nodePath : "";
    this.addSettingTab(new NodePathSettingTab(this.app, this, nodePath, async value => {
      await this.saveData({ nodePath: value });
    }));
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    const statusBar = this.addStatusBarItem();
    statusBar.setText("Copilot: starting…");
    const auth = new CopilotAuth({
      ready: () => !!this.server?.connection && !this.unloaded,
      resetSession: async () => {
        await this.server?.stop();
        if (!this.unloaded) await this.server?.start();
      },
      status: status => {
        if (!this.unloaded) statusBar.setText(status
          ? `Copilot: ${status.kind}${status.busy ? " (busy)" : ""}`
          : "Copilot: unavailable");
      },
      notice: message => { if (!this.unloaded) new Notice(message, 7000); },
      openUrl: async url => { window.open(url, "_blank", "noopener,noreferrer"); },
      showCode: (code, proceed, cancel) => {
        const modal = new CopilotSignInModal(this.app, code, proceed, cancel);
        modal.open();
        return modal;
      },
    });
    this.addCommand({ id: "copilot-sign-in", name: "Sign in to Copilot", callback: () => { void auth.signIn(); } });
    this.addCommand({ id: "copilot-sign-out", name: "Sign out of Copilot", callback: () => { void auth.signOut(); } });
    let notified = false;
    this.server = new CopilotServerManager({
      nodePath,
      vaultPath: adapter.getBasePath(),
      editorVersion: apiVersion,
      pluginVersion: this.manifest.version,
      configureConnection: rpc => auth.attach(rpc),
      onFailure: message => {
        if (!this.unloaded) statusBar.setText("Copilot: unavailable");
        if (!notified && !this.unloaded) { notified = true; new Notice(message, 7000); }
      },
    });
    // Discovery/startup must never block editor registration or plugin loading.
    void this.server.start();
  }
}
