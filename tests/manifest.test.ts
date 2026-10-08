import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "mocha";

const readJson = (filename: string) =>
  JSON.parse(readFileSync(resolve(filename), "utf8"));

describe("plugin manifest", () => {
  it("matches the package version", () => {
    const manifest = readJson("manifest.json");
    const pkg = readJson("package.json");

    assert.equal(manifest.version, pkg.version);
  });

  it("declares the plugin identity and minimum Obsidian version", () => {
    const manifest = readJson("manifest.json");

    assert.equal(manifest.id, "obsidian-inline-suggestions");
    assert.equal(manifest.name, "Inline Suggestions");
    assert.match(manifest.minAppVersion, /^\d+\.\d+\.\d+$/);
    assert.equal(typeof manifest.isDesktopOnly, "boolean");
  });
});
