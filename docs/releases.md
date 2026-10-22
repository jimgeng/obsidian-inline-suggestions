# Releases

`main` is the integration branch. Merging a PR does **not** publish a release; only pushing a version tag triggers [the release workflow](../.github/workflows/release.yml). No production branch is needed. The workflow creates a **draft**, which a maintainer reviews and publishes manually.

## Prepare a release

From an up-to-date `main`, create a release branch and run:

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

## Create the draft

After the PR is merged, check out its merged commit on `main` and tag it:

```sh
git switch main
git pull --ff-only
git tag X.Y.Z
git push origin X.Y.Z
```

Tags must exactly match the version, **without a `v` prefix**. The workflow runs checks, builds the plugin, validates matching versions, and creates a draft GitHub release with generated notes, `main.js`, `manifest.json`, optional `styles.css`, and the install-ready ZIP. It does not publish to Obsidian's community plugin directory.

## Review and publish

1. Wait for the release workflow to succeed in the repository's **Actions** tab.
2. Open the repository's [Releases page](https://github.com/jimgeng/obsidian-inline-suggestions/releases) while signed in with write access, find the draft for `X.Y.Z`, and click **Edit**.
3. Review and edit the title and generated release notes. Confirm the expected assets are attached; download the ZIP and smoke-test it in a test vault if you have not already checked that build.
4. Click **Publish release** when ready. Until then, the draft is not a public release and does not replace the latest published release used by the README's installation link.

You can edit the release title and notes after publication as well. Do not move published tags; use a new patch version for corrections to released code.
