import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { discoverServer, DiscoveryError, DiscoveryErrorCode, discoveryMessages, DiscoveryHost } from "../src/copilot/discovery";

function fixture(platform: NodeJS.Platform = "linux") {
  const windows = platform === "win32";
  const node = windows ? "C:\\Program Files\\nodejs\\node.exe" : "/usr/local/bin/node";
  const npm = windows ? "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" : "/usr/local/lib/node_modules/npm/bin/npm-cli.js";
  const root = windows ? "C:\\Global packages\\node_modules" : "/global packages/node_modules";
  const server = windows ? `${root}\\@github\\copilot-language-server\\dist\\language-server.js` : `${root}/@github/copilot-language-server/dist/language-server.js`;
  const files = new Set([node, npm, server]);
  const calls: [string, string[]][] = [];
  const io: DiscoveryHost = {
    platform,
    path: windows ? '"C:\\Program Files\\nodejs";C:\\Other' : "/missing:/usr/local/bin",
    executable: async file => files.has(file),
    realpath: async file => {
      if (!windows && file === "/usr/local/bin/npm" && files.has(npm)) return npm;
      if (!files.has(file)) throw new Error("ENOENT");
      return file;
    },
    run: async (file, args) => {
      calls.push([file, args]);
      return args[0] === "--version" ? "v24.0.0" : `${root}\n`;
    },
  };
  return { io, files, calls, node, npm, server };
}

describe("Copilot executable discovery", () => {
  for (const platform of ["linux", "darwin", "win32"] as const) {
    it(`resolves Node and global npm server on ${platform} without a shell`, async () => {
      const f = fixture(platform);
      assert.deepEqual(await discoverServer("", f.io), { node: f.node, server: f.server });
      assert.deepEqual(f.calls, [[f.node, ["--version"]], [f.node, [f.npm, "root", "-g"]]]);
    });
  }
  it("uses an absolute Node override rather than PATH", async () => {
    const f = fixture();
    f.files.add("/custom/node");
    assert.equal((await discoverServer(" /custom/node ", f.io)).node, "/custom/node");
    assert.equal(f.calls[0][0], "/custom/node");
  });
  it("resolves a Unix npm symlink from PATH", async () => {
    const f = fixture();
    f.files.delete(f.npm);
    f.files.add("/other/npm/bin/npm-cli.js");
    f.io.realpath = async file => {
      if (file === "/usr/local/bin/npm") return "/other/npm/bin/npm-cli.js";
      if (!f.files.has(file)) throw new Error("ENOENT");
      return file;
    };
    await discoverServer("", f.io);
    assert.deepEqual(f.calls[1][1], ["/other/npm/bin/npm-cli.js", "root", "-g"]);
  });
  it("returns the resolved absolute Node path rather than a relative PATH candidate", async () => {
    const f = fixture();
    f.io.path = "relative/bin:/usr/local/bin";
    f.files.add("relative/bin/node");
    const realpath = f.io.realpath;
    f.io.realpath = async file => file === "relative/bin/node" ? f.node : realpath(file);
    assert.equal((await discoverServer("", f.io)).node, f.node);
  });
  it("does not fall back when an explicit override is invalid", async () => {
    const f = fixture();
    await assert.rejects(discoverServer("/absent/node", f.io), /Node.js was not found/);
    await assert.rejects(discoverServer("node --flag", f.io), /absolute path/);
    assert.equal(f.calls.length, 0);
  });
  it("reports missing Node, npm, and server without installing anything", async () => {
    for (const missing of ["node", "npm", "server"] as const) {
      const f = fixture();
      f.files.delete(f[missing]);
      await assert.rejects(discoverServer("", f.io), missing === "node" ? /Node.js was not found/ : missing === "npm" ? /npm was not found/ : /npm i -g/);
      assert.ok(f.calls.length <= 2);
    }
  });
  it("rejects old Node and invalid npm output", async () => {
    const f = fixture();
    f.io.run = async () => "v20.7.0";
    await assert.rejects(discoverServer("", f.io), /20.8/);
    f.io.run = async (_, args) => args[0] === "--version" ? "v20.8.0" : "not a path";
    await assert.rejects(discoverServer("", f.io), /global package directory/);
  });
  it("classifies all discovery failures with static messages and no private exception data", async () => {
    const secret = "private /vault/note.md token=secret stderr note text";
    const cases: [DiscoveryErrorCode, (f: ReturnType<typeof fixture>) => void, string?][] = [
      ["invalid_node_path", () => {}, secret],
      ["node_not_found", f => { f.files.delete(f.node); }],
      ["node_probe_failed", f => { f.io.run = async () => { throw new Error(secret); }; }],
      ["node_version", f => { f.io.run = async () => secret; }],
      ["node_resolution_failed", f => { f.io.realpath = async () => { throw new Error(secret); }; }],
      ["npm_not_found", f => { f.files.delete(f.npm); }],
      ["npm_probe_failed", f => { f.io.run = async (_, args) => {
        if (args[0] === "--version") return "v24.0.0";
        throw new Error(secret);
      }; }],
      ["npm_root_invalid", f => { f.io.run = async (_, args) => args[0] === "--version" ? "v24.0.0" : secret; }],
      ["server_not_found", f => { f.files.delete(f.server); }],
    ];
    for (const [code, setup, override] of cases) {
      const f = fixture();
      setup(f);
      await assert.rejects(discoverServer(override ?? "", f.io), error => {
        assert.ok(error instanceof DiscoveryError);
        assert.equal(error.code, code);
        assert.equal(error.message, discoveryMessages[code]);
        assert.ok(!String(error).includes(secret));
        assert.equal("cause" in error, false);
        return true;
      });
    }
  });
});
