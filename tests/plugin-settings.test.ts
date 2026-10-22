import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { PluginSettings, PluginSettingsStore } from "../src/plugin-settings";

const fail = (error: unknown) => { throw error; };

describe("plugin settings", () => {
  it("defaults to enabled and migrates existing Node path settings", () => {
    for (const data of [null, undefined, [], "invalid", { automaticSuggestions: "false", nodePath: 123 }]) {
      assert.deepEqual(new PluginSettingsStore(data, async () => {}, fail).current,
        { nodePath: "", automaticSuggestions: true });
    }
    assert.deepEqual(new PluginSettingsStore({ nodePath: "C:/node.exe" }, async () => {}, fail).current,
      { nodePath: "C:/node.exe", automaticSuggestions: true });
  });

  it("persists both preferences together and restores off after reload", async () => {
    let saved: unknown;
    const store = new PluginSettingsStore({ nodePath: "C:/node.exe" }, async value => { saved = value; }, fail);
    const observed: boolean[] = [];
    const unsubscribe = store.subscribe(() => observed.push(store.current.automaticSuggestions));
    await store.setAutomaticSuggestions(false);
    assert.deepEqual(saved, { nodePath: "C:/node.exe", automaticSuggestions: false });
    await store.setNodePath(" D:/node.exe ");
    const reloaded = new PluginSettingsStore(saved, async () => {}, fail);
    assert.deepEqual(reloaded.current, { nodePath: "D:/node.exe", automaticSuggestions: false });
    unsubscribe();
    await store.setAutomaticSuggestions(true);
    assert.deepEqual(observed, [true, false, false]);
  });

  it("updates subscribers synchronously and serializes rapid saves", async () => {
    const snapshots: PluginSettings[] = [];
    let release!: () => void;
    const store = new PluginSettingsStore({}, async value => {
      snapshots.push(value);
      if (snapshots.length === 1) await new Promise<void>(resolve => { release = resolve; });
    }, fail);
    let enabled = true;
    store.subscribe(() => { enabled = store.current.automaticSuggestions; });
    const first = store.setAutomaticSuggestions(false);
    assert.equal(enabled, false);
    const second = store.setNodePath("node");
    const third = store.setAutomaticSuggestions(true);
    assert.equal(enabled, true);
    await Promise.resolve();
    assert.equal(snapshots.length, 1);
    release();
    await Promise.all([first, second, third]);
    assert.deepEqual(snapshots, [
      { nodePath: "", automaticSuggestions: false },
      { nodePath: "node", automaticSuggestions: false },
      { nodePath: "node", automaticSuggestions: true },
    ]);
  });

  it("reports failed saves without blocking subsequent writes", async () => {
    let calls = 0;
    const errors: unknown[] = [];
    const store = new PluginSettingsStore({}, async () => { if (++calls === 1) throw new Error("disk full"); },
      error => errors.push(error));
    await store.setAutomaticSuggestions(false);
    assert.equal(errors.length, 1);
    assert.equal(store.current.automaticSuggestions, false);
    await store.setNodePath("node");
    assert.equal(calls, 2);
  });
});
