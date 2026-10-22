import type { ButtonComponent, Setting } from "obsidian";

/** Minimal native Setting surface used by auth controls; no Obsidian runtime in Node. */
export function createSetting(container: HTMLElement): Setting {
  const doc = container.ownerDocument;
  const settingEl = container.appendChild(doc.createElement("div"));
  const nameEl = settingEl.appendChild(doc.createElement("div"));
  const descEl = settingEl.appendChild(doc.createElement("div"));
  const controlEl = settingEl.appendChild(doc.createElement("div"));
  const setting = {
    settingEl, descEl, controlEl,
    setName(name: string) { nameEl.textContent = name; return setting; },
    setHeading() { settingEl.setAttribute("data-heading", "true"); return setting; },
    addButton(build: (button: ButtonComponent) => unknown) {
      const buttonEl = controlEl.appendChild(doc.createElement("button"));
      const button = {
        buttonEl,
        setButtonText(text: string) { buttonEl.textContent = text; return button; },
        setCta() { buttonEl.classList.add("mod-cta"); return button; },
        onClick(callback: () => void) { buttonEl.addEventListener("click", callback); return button; },
      };
      build(button as unknown as ButtonComponent);
      return setting;
    },
  };
  return setting as unknown as Setting;
}
