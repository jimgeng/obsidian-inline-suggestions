export interface PluginSettings {
  nodePath: string;
  automaticSuggestions: boolean;
}

/** One shared source of truth for settings, status-bar actions and commands. */
export class PluginSettingsStore {
  private value: PluginSettings;
  private readonly listeners = new Set<() => void>();
  private saving: Promise<void> = Promise.resolve();

  constructor(data: unknown, private readonly persist: (settings: PluginSettings) => Promise<void>,
    private readonly onSaveError: (error: unknown) => void) {
    const raw = data && typeof data === "object" ? data as Partial<PluginSettings> : {};
    this.value = {
      nodePath: typeof raw.nodePath === "string" ? raw.nodePath : "",
      automaticSuggestions: typeof raw.automaticSuggestions === "boolean" ? raw.automaticSuggestions : true,
    };
  }

  get current(): Readonly<PluginSettings> { return this.value; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    listener();
    return () => { this.listeners.delete(listener); };
  }

  setAutomaticSuggestions(enabled: boolean): Promise<void> {
    return this.update({ automaticSuggestions: enabled });
  }

  setNodePath(nodePath: string): Promise<void> {
    return this.update({ nodePath: nodePath.trim() });
  }

  private update(patch: Partial<PluginSettings>): Promise<void> {
    this.value = { ...this.value, ...patch };
    const snapshot = { ...this.value };
    for (const listener of this.listeners) listener();
    // Serialize writes so rapid clicks/text edits cannot persist an older snapshot last.
    this.saving = this.saving.then(() => this.persist(snapshot)).catch(this.onSaveError);
    return this.saving;
  }
}
