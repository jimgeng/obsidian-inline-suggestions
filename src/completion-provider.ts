/** Plain-text context keeps providers independent of Obsidian and CodeMirror. */
export interface CompletionContext {
  readonly prefix: string;
  readonly suffix: string;
}

export interface CompletionProvider {
  /** Return insertion text, or null when there is no completion. */
  complete(context: CompletionContext): Promise<string | null>;
}
