## Current Project Status

Editor-only ghost-text slice implemented; no completion provider, authentication, or automatic requests yet. Run `Inline Suggestions: Preview ghost text (demo)` at a line end, then Tab to accept all, Ctrl/Cmd+Right for a word, or Escape to dismiss. Multiline previews are intentionally restricted to line ends. Blur, composition, edits, and explicit selection changes dismiss suggestions.

Build/typecheck and jsdom transaction/DOM tests pass. Real Obsidian verification remains: Source mode and Live Preview wrapping/scrolling, actual IME input, undo/redo, split panes, keybinding conflicts, and disable/re-enable with a visible ghost. Test in a scratch note/vault first; jsdom does not validate layout or host-plugin interaction. The host `Editor.cm` bridge is feature-detected but not a public typed Obsidian API.
