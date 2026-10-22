import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import type { CopilotAuth } from "./copilot/auth";
import { bindAuthSettings } from "./copilot/auth-controls";
import { PluginSettingsStore } from "./plugin-settings";

export class InlineSuggestionsSettingTab extends PluginSettingTab {
  private disposeControls?: () => void;

  constructor(app: App, plugin: Plugin, private readonly settings: PluginSettingsStore, private readonly auth?: CopilotAuth) {
    super(app, plugin);
  }

  hide(): void {
    this.disposeControls?.();
    this.disposeControls = undefined;
  }

  display(): void {
    this.hide();
    this.containerEl.empty();
    new Setting(this.containerEl).setName("Status").setHeading();
    let unsubscribe = () => {};
    new Setting(this.containerEl)
      .setName("Automatic suggestions")
      .setDesc("Enable Copilot suggestions while typing. You can also toggle this from the status bar when signed in.")
      .addToggle(toggle => {
        toggle.setValue(this.settings.current.automaticSuggestions)
          .onChange(value => { void this.settings.setAutomaticSuggestions(value); });
        unsubscribe = this.settings.subscribe(() => toggle.setValue(this.settings.current.automaticSuggestions));
      });
    const disposeAuth = this.auth ? bindAuthSettings(this.containerEl, this.auth, el => new Setting(el)) : undefined;
    this.disposeControls = () => { unsubscribe(); disposeAuth?.(); };
    new Setting(this.containerEl).setName("System configuration").setHeading();
    new Setting(this.containerEl)
      .setName("Node path")
      .setDesc("Optional absolute path to Node.js 20.8+. Leave empty to use PATH. Reload the plugin after changing this. The global @github/copilot-language-server package must already be installed (npm i -g @github/copilot-language-server).")
      .addText(text => text.setPlaceholder("Automatic (PATH)").setValue(this.settings.current.nodePath).onChange(value => {
        void this.settings.setNodePath(value);
      }));
  }
}
