import { App, Modal, Notice } from "obsidian";

export class CopilotSignInModal extends Modal {
  constructor(app: App, private readonly code: string, private readonly proceed: () => void, private readonly cancel: () => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Sign in to Copilot");
    this.contentEl.createEl("p", { text: "Copy this code, then open GitHub in your browser and enter it when asked. Keep this window open until sign-in finishes." });
    this.contentEl.createEl("pre").createEl("code", { text: this.code });
    const copy = this.contentEl.createEl("button", { text: "Copy code" });
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(this.code).then(
        () => { copy.setText("Copied"); },
        () => { new Notice("Could not copy the code. Select and copy it manually."); },
      );
    });
    const browser = this.contentEl.createEl("button", { text: "Open browser", cls: "mod-cta" });
    browser.addEventListener("click", () => {
      browser.disabled = true;
      browser.setText("Waiting for GitHub…");
      this.proceed();
    });
    const cancel = this.contentEl.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
    this.cancel();
  }
}
