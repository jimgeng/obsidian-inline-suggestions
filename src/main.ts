import { apiVersion, Editor, FileSystemAdapter, Notice, Plugin } from "obsidian";
import { CopilotServerManager } from "./copilot/server-manager";
import { CopilotAuth } from "./copilot/auth";
import { CopilotSignInModal } from "./copilot/auth-modal";
import { bindAuthStatusBar } from "./copilot/auth-controls";
import { InlineSuggestionsSettingTab } from "./settings";
import { PluginSettingsStore } from "./plugin-settings";
import { EditorView } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { acceptGhost, ghostTextExtension } from "./ghost-text";
import { createCompletionIntegration } from "./completion-extension";
import { CopilotCompletionProvider } from "./copilot/completion-provider";
import { FakeCompletionProvider } from "./fake-provider";

// Obsidian exposes CM6 here at runtime, but not in its public Editor typings.
// Feature-detect it and keep this host-specific bridge out of the editor slice.
function codeMirror(editor: Editor): EditorView | undefined {
  const cm = (editor as Editor & { cm?: EditorView }).cm;
  return cm && typeof cm.dispatch === "function" && cm.state ? cm : undefined;
}

export default class InlineSuggestionsPlugin extends Plugin {
  private readonly demoProvider = new FakeCompletionProvider();

  private server?: CopilotServerManager;
  private unloaded = false;

  async onload(): Promise<void> {
    this.register(() => {
      this.unloaded = true;
      void this.server?.stop();
    });
    let auth: CopilotAuth | undefined;
    let preferences: PluginSettingsStore | undefined;
    const enabled = () => !this.unloaded && preferences?.current.automaticSuggestions === true && auth?.canComplete === true;
    const completions = createCompletionIntegration(view => new CopilotCompletionProvider(
      () => this.server?.connection,
      () => {
        // Obsidian's vault configuration accessor is runtime-only, like Editor.cm.
        const vault = this.app.vault as typeof this.app.vault & { getConfig?(key: string): unknown };
        return { tabSize: view.state.tabSize, insertSpaces: vault.getConfig?.("useTab") !== true };
      },
      enabled,
      { onStalled: rpc => {
        if (this.server?.connection === rpc && !this.unloaded) {
          void this.server.stop()
            .then(() => { if (!this.unloaded) return this.server?.start(); })
            .catch(() => { if (!this.unloaded) new Notice("Copilot server could not restart. Reload the plugin to try again.", 7000); });
        }
      } },
    ), view => {
      const info = view.state.field(editorInfoField, false);
      return typeof info?.file?.path === "string" && info.file.path.toLowerCase().endsWith(".md");
    }, enabled);
    this.register(() => completions.dispose());
    this.registerEditorExtension(ghostTextExtension);
    this.registerEditorExtension(completions.extension);
    // this.addCommand({
    //   id: "preview-ghost-text",
    //   name: "Preview ghost text (demo)",
    //   editorCallback: async editor => {
    //     const view = codeMirror(editor);
    //     if (!view) return;
    //     await completions.preview(view, this.demoProvider);
    //   },
    // });
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
        if (view) completions.dismiss(view);
      },
    });

    const data: unknown = await this.loadData();
    if (this.unloaded) return;
    preferences = new PluginSettingsStore(data, value => this.saveData(value), () => {
      if (!this.unloaded) new Notice("Could not save Inline Suggestions settings. Your changes may not survive a reload.", 7000);
    });
    const pluginSettings = preferences;
    const { nodePath } = pluginSettings.current;
    this.register(pluginSettings.subscribe(() => { if (!enabled()) completions.invalidate(); }));
    this.addCommand({
      id: "toggle-automatic-suggestions", name: "Toggle automatic suggestions",
      callback: () => { void pluginSettings.setAutomaticSuggestions(!pluginSettings.current.automaticSuggestions); },
    });
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      const settings = new InlineSuggestionsSettingTab(this.app, this, pluginSettings);
      this.addSettingTab(settings);
      this.register(() => settings.hide());
      return;
    }
    const statusBar = this.addStatusBarItem();
    statusBar.setText("Copilot: starting…");
    auth = new CopilotAuth({
      ready: () => !!this.server?.connection && !this.unloaded,
      resetSession: async () => {
        await this.server?.stop();
        if (!this.unloaded) await this.server?.start();
      },
      notice: message => { if (!this.unloaded) new Notice(message, 7000); },
      openUrl: async url => { window.open(url, "_blank", "noopener,noreferrer"); },
      showCode: (code, proceed, cancel) => {
        const modal = new CopilotSignInModal(this.app, code, proceed, cancel);
        modal.open();
        return modal;
      },
    });
    const copilotAuth = auth;
    this.register(auth.subscribe(() => { if (!enabled()) completions.invalidate(); }));
    this.register(bindAuthStatusBar(statusBar, auth, pluginSettings));
    const settings = new InlineSuggestionsSettingTab(this.app, this, pluginSettings, auth);
    this.addSettingTab(settings);
    this.register(() => settings.hide());
    this.addCommand({ id: "copilot-sign-in", name: "Sign in to Copilot", callback: () => { void copilotAuth.signIn(); } });
    this.addCommand({ id: "copilot-sign-out", name: "Sign out of Copilot", callback: () => { void copilotAuth.signOut(); } });
    let notified = false;
    this.server = new CopilotServerManager({
      nodePath,
      vaultPath: adapter.getBasePath(),
      editorVersion: apiVersion,
      pluginVersion: this.manifest.version,
      configureConnection: rpc => copilotAuth.attach(rpc),
      onReady: () => copilotAuth.connectionChanged(),
      onFailure: message => {
        copilotAuth.connectionChanged();
        if (!notified && !this.unloaded) { notified = true; new Notice(message, 7000); }
      },
    });
    // Discovery/startup must never block editor registration or plugin loading.
    void this.server.start();
  }
}
