import { App, Plugin, PluginSettingTab, Setting } from "obsidian";

export class NodePathSettingTab extends PluginSettingTab {
  constructor(app: App, plugin: Plugin, private nodePath: string, private readonly save: (value: string) => Promise<void>) {
    super(app, plugin);
  }

  display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName("Node path")
      .setDesc("Optional absolute path to Node.js 20.8+. Leave empty to use PATH. Reload the plugin after changing this. The global @github/copilot-language-server package must already be installed (npm i -g @github/copilot-language-server).")
      .addText(text => text.setPlaceholder("Automatic (PATH)").setValue(this.nodePath).onChange(async value => {
        this.nodePath = value.trim();
        await this.save(this.nodePath);
      }));
  }
}
