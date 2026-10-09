import { Editor, Plugin } from "obsidian";
import { EditorView } from "@codemirror/view";
import { acceptGhost, dismissGhost, ghostTextExtension, showGhost } from "./ghost-text";
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

  onload(): void {
    this.registerEditorExtension(ghostTextExtension);
    this.addCommand({
      id: "preview-ghost-text",
      name: "Preview ghost text (demo)",
      editorCallback: async editor => {
        const view = codeMirror(editor);
        if (!view) return;
        view.focus();
        const source = view.state;
        const selection = source.selection;
        if (source.readOnly || selection.ranges.length !== 1 || !selection.main.empty) return;
        const at = selection.main.head;
        try {
          const text = await this.completionProvider.complete({
            prefix: source.doc.sliceString(0, at),
            suffix: source.doc.sliceString(at),
          });
          if (text !== null) showGhost(view, source, text);
        } catch {
          // Provider failures must not interfere with normal editing.
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
  }
}
