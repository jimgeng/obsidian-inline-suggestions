# Obsidian Inline Suggestions

GitHub Copilot-powered inline Markdown suggestions in Obsidian, using your existing Copilot entitlement rather than a separate OpenAI/Codex API subscription.

## Setup

Requires **Obsidian desktop**, a GitHub account with Copilot access, and **Node.js 20.8+** with npm.

1. Install GitHub's official language server:
   ```sh
   npm i -g @github/copilot-language-server
   ```
2. Download `obsidian-inline-suggestions-X.Y.Z.zip` from the [latest GitHub release](https://github.com/jimgeng/obsidian-inline-suggestions/releases/latest).
3. Extract the ZIP into `<vault>/.obsidian/plugins/` (create `plugins` if needed). The result should be `.obsidian/plugins/obsidian-inline-suggestions/main.js` and `manifest.json`, not an extra nested folder. Do not use GitHub's automatically generated **Source code** archives.
4. In Obsidian, turn off Restricted mode under **Community plugins**, reload Obsidian, then enable **Inline Suggestions**.
5. Run **Inline Suggestions: Sign in to Copilot** from Obsidian's command palette and follow the GitHub sign-in prompts.

If Node cannot be found, set **Node path** in the plugin settings to the absolute path of your Node executable, then reload the plugin. The language server manages authentication and tokens.

To update, disable the plugin, replace its `main.js` and `manifest.json` with the new release files (and `styles.css` if included), then enable it again. Preserve `data.json`, which contains your settings. No source checkout or build tools are needed for installation.

## Usage

Pause while typing in a Markdown note to see a suggestion.

- **Tab**: accept the suggestion.
- **Ctrl+Right** (Windows/Linux) or **Cmd+Right** (macOS): accept the next suggested word.
- **Escape** or interactions with other UI: dismiss the suggestion.

Toggle automatic suggestions in the plugin settings or with **Inline Suggestions: Toggle automatic suggestions**. When Copilot is unavailable, normal editing continues without suggestions.

## Development

Use **Node.js 20.19+ or 22.12+** for the development tooling (a higher minimum than the plugin's runtime requirement).

```sh
npm ci
npm run dev        # Watch and rebuild main.js
npm run typecheck  # Check source and test TypeScript
npm test           # Run tests
npm run test:watch # Rerun tests when files change
npm run build      # Type-check and produce a production main.js
```

Tests in `tests/**/*.test.ts` run in Node, not inside Obsidian; host-specific behavior requires mocks or manual testing in a vault.

### Deploy to your vault

Copy `.env.example` to `.env` and set your vault root, using forward slashes on Windows:

```dotenv
OBSIDIAN_VAULT_PATH="C:/Users/you/Documents/My Vault"
```

Run `npm run deploy` to build and copy the plugin into `<vault>/.obsidian/plugins/obsidian-inline-suggestions/`. The vault must already contain an `.obsidian` folder. `.env` is gitignored and existing plugin settings are preserved.

Enable **Inline Suggestions** after the first deployment. After subsequent deployments, disable/enable the plugin or restart Obsidian to load the new build.

## Releases

`main` is the integration branch. Merging a PR does **not** publish a release; only pushing a version tag triggers `.github/workflows/release.yml`. No production branch is needed.

To prepare a release from an up-to-date `main`, create a release branch and run:

```sh
npm ci
npm version patch --no-git-tag-version # or minor / major / an explicit X.Y.Z
npm run typecheck
npm test
npm run build
python -m unittest discover -s scripts -p 'test_*.py'
python scripts/package-release.py --tag X.Y.Z
```

Use the actual version in place of `X.Y.Z`. Packaging requires Python 3 (standard library only; CI sets it up automatically). `npm version` updates `package.json` and `package-lock.json`; its lifecycle script synchronizes `manifest.json` and adds the minimum Obsidian version to `versions.json`. If compatibility changes, update `manifest.json`'s `minAppVersion` **before** bumping the version. Releases use stable SemVer (`X.Y.Z`, no prerelease suffix).

Commit the four version files and open a PR. Before publishing, manually extract `dist/obsidian-inline-suggestions-X.Y.Z.zip` into a test vault and confirm the plugin loads and sign-in/suggestions work. Automated checks verify ZIP contents and metadata, not installation inside Obsidian.

After the PR is merged, check out its merged commit on `main` and tag it:

```sh
git switch main
git pull --ff-only
git tag X.Y.Z
git push origin X.Y.Z
```

Tags must exactly match the version, **without a `v` prefix**. The workflow runs checks, builds the plugin, validates matching versions, and publishes a GitHub release with generated notes, `main.js`, `manifest.json`, optional `styles.css`, and the install-ready ZIP. It does not publish to Obsidian's community plugin directory. Do not move published tags; use a new patch version for corrections.

## License

[MIT](LICENSE). Third-party dependencies retain their own licenses.

## Scope

Focused on low-latency inline Markdown completions, not AI chat, autonomous editing, or a generic multi-provider framework. Reproducing every VS Code Copilot feature, speculative backend services, and elaborate configuration are outside the project's scope.
