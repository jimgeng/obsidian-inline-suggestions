import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import type { CopilotAuth } from "./copilot/auth";
import { bindAuthSettings } from "./copilot/auth-controls";

export class NodePathSettingTab extends PluginSettingTab {
  private disposeAuthentication?: () => void;

  constructor(app: App, plugin: Plugin, private nodePath: string, private readonly save: (value: string) => Promise<void>, private readonly auth?: CopilotAuth) {
    super(app, plugin);
  }

  hide(): void {
    this.disposeAuthentication?.();
    this.disposeAuthentication = undefined;
  }

  display(): void {
    this.hide();
    this.containerEl.empty();
    if (this.auth) this.disposeAuthentication = bindAuthSettings(this.containerEl, this.auth);
    new Setting(this.containerEl)
      .setName("Node path")
      .setDesc("Optional absolute path to Node.js 20.8+. Leave empty to use PATH. Reload the plugin after changing this. The global @github/copilot-language-server package must already be installed (npm i -g @github/copilot-language-server).")
      .addText(text => text.setPlaceholder("Automatic (PATH)").setValue(this.nodePath).onChange(async value => {
        this.nodePath = value.trim();
        await this.save(this.nodePath);
      }));
  }
}
