# Obsidian Inline Suggestions

## Development

```sh
npm ci
npm run dev        # Watch and rebuild main.js
npm run typecheck  # Check source and test TypeScript
npm test           # Run Mocha tests
npm run test:watch # Rerun tests when files change
npm run build      # Type-check and produce a production main.js
```

Tests live in `tests/**/*.test.ts` and run through `tsx`, using Mocha and Node's built-in `node:assert` assertions. `npm run typecheck` checks tests too; `tsx` itself does not type-check. Tests run in Node, not inside Obsidian, so code that imports the Obsidian runtime requires mocks or host-specific integration testing.

### Deploy to your vault

Use Node.js 20.19+ or 22.12+ (required by the development tooling). Copy `.env.example` to `.env` and set `OBSIDIAN_VAULT_PATH` to your vault root, using forward slashes on Windows:

```dotenv
OBSIDIAN_VAULT_PATH="C:/Users/you/Documents/My Vault"
```

`.env` is gitignored. Run `npm run deploy` to type-check, build, and copy `main.js`, `manifest.json`, and `styles.css` (if present) into `<vault>/.obsidian/plugins/obsidian-inline-suggestions/`. The vault must already contain an `.obsidian` folder; relative vault paths are resolved from this project. Existing plugin settings are preserved.

Enable **Inline Suggestions** in Obsidian's community plugin settings after the first deployment. After subsequent deployments, reload the plugin (disable/enable it) or restart Obsidian to load the new build.

## Goal

Provide low-latency, GitHub Copilot-style inline Markdown completions in Obsidian using the user's existing GitHub Copilot entitlement. The primary intended configuration should not require a separate OpenAI/Codex API subscription.

## Intended Behavior

- After an appropriate typing pause, request a completion using context around the cursor.
- Display inline ghost text with straightforward acceptance (likely Tab).
- Invalidate suggestions after relevant document changes; stale asynchronous responses must not affect newer editor state.
- Cancel or ignore in-flight work as appropriate.
- Stay responsive during requests and fail unobtrusively when Copilot is unavailable, without interfering with normal editing.

## Constraints

- GitHub-specific transport and authentication must stay isolated behind a completion-provider boundary, separate from editor/rendering logic. 
- Undocumented Copilot behavior must be easy to replace; its current API details are not settled project requirements.

## Initial Non-goals

- AI chat, autonomous agent mode, or vault-wide autonomous editing.
- A generic multi-provider AI framework.
- Elaborate settings before they are needed.
- Speculative synchronization or backend services.
- Reproducing every VS Code Copilot feature.
