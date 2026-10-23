import assert from "node:assert/strict";
import { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "mocha";
import { createMessageConnection, MessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import { DiscoveryError, discoveryMessages, DiscoveryErrorCode } from "../src/copilot/discovery";
import { CopilotServerManager, ServerHost } from "../src/copilot/server-manager";

const managers: CopilotServerManager[] = [];
const peers: MessageConnection[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.stop()));
  for (const peer of peers.splice(0)) peer.dispose();
});

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail("Timed out waiting for lifecycle event");
}

function fixture(options: {
  hangInitialize?: boolean;
  hangShutdown?: boolean;
  ignoreKill?: boolean;
  configureConnection?: (rpc: MessageConnection) => () => void;
  onReady?: () => void;
} = {}) {
  const children: (ChildProcessWithoutNullStreams & { kills: (string | undefined)[] })[] = [];
  const messages: { method: string; params?: any }[] = [];
  const failures: string[] = [];
  const host: ServerHost = {
    timeoutMs: 15,
    initializeTimeoutMs: 100,
    discover: async () => ({ node: "/node", server: "/global/server.js" }),
    spawn: () => {
      const emitter = new EventEmitter();
      const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
      const child = Object.assign(emitter, {
        stdin, stdout, stderr,
        kills: [] as (string | undefined)[],
        kill(signal?: string) {
          this.kills.push(signal);
          if (!options.ignoreKill || signal === "SIGKILL") emitter.emit("exit", 0, signal);
          return true;
        },
      }) as unknown as typeof children[number];
      children.push(child);
      const peer = createMessageConnection(new StreamMessageReader(stdin), new StreamMessageWriter(stdout));
      peers.push(peer);
      peer.onRequest("initialize", params => {
        messages.push({ method: "initialize", params });
        if (options.configureConnection) void peer.sendNotification("didChangeStatus", { kind: "Normal", busy: false });
        return options.hangInitialize ? new Promise(() => {}) : { capabilities: {} };
      });
      peer.onRequest("shutdown", () => {
        messages.push({ method: "shutdown" });
        return options.hangShutdown ? new Promise(() => {}) : null;
      });
      peer.onNotification("exit", () => { messages.push({ method: "exit" }); child.emit("exit", 0); });
      peer.onNotification("initialized", params => messages.push({ method: "initialized", params }));
      peer.onNotification("workspace/didChangeConfiguration", params => messages.push({ method: "workspace/didChangeConfiguration", params }));
      peer.listen();
      return child;
    },
    connect: child => createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin)),
  };
  const manager = new CopilotServerManager({ nodePath: "", vaultPath: process.cwd(), editorVersion: "1.13.0", pluginVersion: "0.1.0", onFailure: message => failures.push(message), configureConnection: options.configureConnection, onReady: options.onReady }, host);
  managers.push(manager);
  return { manager, host, children, messages, failures };
}

describe("Copilot server lifecycle (mock process, real JSON-RPC streams)", () => {
  it("initializes once with workspace URI and editor identity, disables telemetry, then shuts down", async () => {
    const f = fixture();
    await Promise.all([f.manager.start(), f.manager.start()]);
    await until(() => f.messages.length === 3);
    assert.equal(f.children.length, 1);
    assert.ok(f.manager.connection);
    assert.deepEqual(f.messages.map(message => message.method), ["initialize", "initialized", "workspace/didChangeConfiguration"]);
    const params = f.messages[0].params;
    assert.equal(params.workspaceFolders[0].uri, pathToFileURL(process.cwd()).href);
    assert.deepEqual(params.initializationOptions, { editorInfo: { name: "Obsidian", version: "1.13.0" }, editorPluginInfo: { name: "Inline Suggestions", version: "0.1.0" } });
    assert.deepEqual(f.messages[2].params, { settings: { telemetry: { telemetryLevel: "off" } } });
    assert.deepEqual(await peers[0].sendRequest("workspace/configuration", { items: [{ section: "telemetry" }, { section: "telemetry.telemetryLevel" }, { section: "unknown" }] }), [{ telemetryLevel: "off" }, "off", null]);
    await f.manager.stop();
    assert.equal(f.manager.connection, undefined);
    assert.deepEqual(f.messages.slice(3).map(message => message.method), ["shutdown", "exit"]);
    assert.deepEqual(f.children[0].kills, []);
    assert.deepEqual(f.failures, []);
    await f.manager.stop();
  });
  it("installs client handlers before initialize and releases each connection once across restart/unload", async () => {
    const statuses: unknown[] = [];
    let attached = 0, released = 0;
    const f = fixture({ configureConnection: rpc => {
      attached++;
      const listener = rpc.onNotification("didChangeStatus", value => statuses.push(value));
      return () => { released++; listener.dispose(); };
    } });
    await f.manager.start();
    await until(() => statuses.length === 1);
    assert.equal(attached, 1);
    assert.deepEqual(f.messages[0].params.capabilities.window, { showDocument: { support: true } });
    f.children[0].emit("exit", 1);
    await until(() => attached === 2 && statuses.length === 2 && !!f.manager.connection);
    assert.equal(released, 1);
    await f.manager.stop();
    await f.manager.stop();
    assert.equal(released, 2);
  });
  it("notifies controls only after the connection is ready", async () => {
    let ready = 0;
    const f = fixture({ onReady: () => {
      assert.ok(f.manager.connection);
      ready++;
    } });
    assert.equal(ready, 0);
    await f.manager.start();
    assert.equal(ready, 1);
    await f.manager.stop();
    await f.manager.start();
    assert.equal(ready, 2);
  });
  it("can retire an authentication session and start a fresh process after it exits", async () => {
    const f = fixture();
    await f.manager.start();
    const old = f.manager.connection;
    await f.manager.stop();
    assert.ok(f.children[0].stdin.destroyed);
    await f.manager.start();
    assert.equal(f.children.length, 2);
    assert.ok(f.manager.connection);
    assert.notEqual(f.manager.connection, old);
    await until(() => f.messages.length === 8);
    assert.deepEqual(f.messages.map(message => message.method), [
      "initialize", "initialized", "workspace/didChangeConfiguration", "shutdown", "exit",
      "initialize", "initialized", "workspace/didChangeConfiguration",
    ]);
  });
  it("does not spawn if unloaded during discovery", async () => {
    const f = fixture();
    let resolve!: (value: { node: string; server: string }) => void;
    f.host.discover = () => new Promise(done => { resolve = done; });
    const starting = f.manager.start();
    await f.manager.stop();
    resolve({ node: "/node", server: "/server" });
    await starting;
    assert.equal(f.children.length, 0);
    assert.deepEqual(f.failures, []);
  });
  it("cancels an in-flight initialize on unload with no late ready connection", async () => {
    const f = fixture({ hangInitialize: true });
    const starting = f.manager.start();
    await until(() => f.messages.length === 1);
    await f.manager.stop();
    await starting;
    assert.equal(f.manager.connection, undefined);
    assert.equal(f.children[0].kills.length, 1);
    assert.deepEqual(f.failures, []);
  });
  it("forces termination when shutdown and normal kill are ignored", async () => {
    const f = fixture({ hangShutdown: true, ignoreKill: true });
    await f.manager.start();
    await f.manager.stop();
    assert.deepEqual(f.children[0].kills, [undefined, "SIGKILL"]);
    assert.ok(f.children[0].stdin.destroyed);
    assert.ok(f.children[0].stdout.destroyed);
    assert.ok(f.children[0].stderr.destroyed);
  });
  it("waits for asynchronous exit after SIGKILL before finishing cleanup", async () => {
    const f = fixture({ hangShutdown: true });
    f.host.timeoutMs = 100;
    await f.manager.start();
    const child = f.children[0];
    child.kill = (signal?: NodeJS.Signals | number) => {
      child.kills.push(signal as string | undefined);
      return true;
    };
    let stopped = false;
    const stopping = f.manager.stop().then(() => { stopped = true; });
    await until(() => child.kills.includes("SIGKILL"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false);
    assert.equal(child.stdin.destroyed, false);
    child.emit("exit", null, "SIGKILL");
    await stopping;
    assert.equal(stopped, true);
    assert.deepEqual(child.kills, [undefined, "SIGKILL"]);
    assert.ok(child.stdin.destroyed);
    assert.ok(child.stdout.destroyed);
    assert.ok(child.stderr.destroyed);
    assert.deepEqual(f.failures, []);
  });
  it("bounds forced termination when no exit event arrives", async () => {
    const f = fixture({ hangShutdown: true });
    await f.manager.start();
    const child = f.children[0];
    child.kill = (signal?: NodeJS.Signals | number) => {
      child.kills.push(signal as string | undefined);
      return true;
    };
    await f.manager.stop();
    assert.deepEqual(child.kills, [undefined, "SIGKILL"]);
    assert.ok(child.stdin.destroyed);
    assert.ok(child.stdout.destroyed);
    assert.ok(child.stderr.destroyed);
    assert.equal(f.manager.connection, undefined);
    assert.deepEqual(f.failures, []);
  });
  it("restarts a crashed ready server only once", async () => {
    const f = fixture();
    await f.manager.start();
    f.children[0].emit("exit", 1);
    await until(() => f.children.length === 2 && !!f.manager.connection);
    f.children[1].emit("exit", 1);
    await until(() => f.failures.length === 1);
    assert.equal(f.children.length, 2);
    assert.equal(f.manager.connection, undefined);
    assert.deepEqual(f.children.map(child => child.kills), [[], []]);
  });
  it("handles a process spawn error without a restart loop", async () => {
    const f = fixture({ hangInitialize: true });
    const starting = f.manager.start();
    await until(() => f.children.length === 1);
    f.children[0].emit("error", new Error("ENOENT"));
    await starting;
    await until(() => f.failures.length > 0);
    assert.equal(f.manager.connection, undefined);
    assert.equal(f.children.length, 1);
  });
  it("does not restart after unload races with a crash", async () => {
    const f = fixture();
    await f.manager.start();
    f.children[0].emit("exit", 1);
    await f.manager.stop();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.children.length, 1);
    assert.deepEqual(f.failures, []);
  });
  it("treats transport closure as a crash and cleans up the child", async () => {
    const f = fixture();
    await f.manager.start();
    (f.children[0].stdout as PassThrough).end();
    await until(() => f.children.length === 2 && !!f.manager.connection);
    assert.equal(f.children[0].kills.length, 1);
  });
  it("times out initialization and terminates without retrying", async () => {
    const f = fixture({ hangInitialize: true });
    f.host.initializeTimeoutMs = 15;
    await f.manager.start();
    assert.equal(f.children.length, 1);
    assert.equal(f.children[0].kills.length, 1);
    assert.equal(f.failures.length, 1);
    assert.equal(f.manager.connection, undefined);
  });
  it("cleans up streams and force-kills if connection construction fails", async () => {
    const f = fixture({ ignoreKill: true });
    f.host.connect = () => { throw new Error("connection construction failed"); };
    await f.manager.start();
    assert.deepEqual(f.children[0].kills, [undefined, "SIGKILL"]);
    assert.ok(f.children[0].stdin.destroyed);
    assert.ok(f.children[0].stdout.destroyed);
    assert.ok(f.children[0].stderr.destroyed);
    assert.equal(f.failures.length, 1);
  });
  for (const blocked of ["exit", "initialized"] as const) {
    it(`bounds a blocked ${blocked} notification write`, async () => {
      const f = fixture();
      f.host.initializeTimeoutMs = 15;
      const connect = f.host.connect;
      f.host.connect = child => {
        const rpc = connect(child);
        return new Proxy(rpc, {
          get(target, key) {
            if (key === "sendNotification") return (method: string, params: unknown) =>
              method === blocked ? new Promise<void>(() => {}) : target.sendNotification(method, params);
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      };
      await f.manager.start();
      await f.manager.stop();
      assert.equal(f.manager.connection, undefined);
      assert.equal(f.children[0].kills.length, 1);
      assert.equal(f.failures.length, blocked === "initialized" ? 1 : 0);
    });
  }
  for (const code of Object.keys(discoveryMessages) as DiscoveryErrorCode[]) {
    it(`preserves the safe discovery category ${code}`, async () => {
      const f = fixture();
      f.host.discover = async () => {
        const error = new DiscoveryError(code);
        error.message = "private path token stderr note text";
        throw error;
      };
      await f.manager.start();
      assert.deepEqual(f.failures, [discoveryMessages[code]]);
      assert.equal(f.children.length, 0);
    });
  }
  for (const stage of ["spawn", "transport", "clientHandlers", "initialize", "configuration", "readyCallback"] as const) {
    it(`reports a sanitized ${stage} failure and retires startup without retry`, async () => {
      const secret = "private /vault/note.md token=secret stderr note text";
      const fail = () => { throw new Error(secret); };
      let released = 0;
      const f = fixture({
        configureConnection: stage === "clientHandlers" ? fail : () => () => { released++; },
        onReady: stage === "readyCallback" ? fail : undefined,
      });
      if (stage === "spawn") f.host.spawn = fail;
      else if (stage === "transport") f.host.connect = fail;
      else if (stage === "initialize" || stage === "configuration") {
        const connect = f.host.connect;
        f.host.connect = child => {
          const rpc = connect(child);
          (child.stderr as PassThrough).write(secret);
          return new Proxy(rpc, {
            get(target, key) {
              if (stage === "initialize" && key === "sendRequest") return fail;
              if (stage === "configuration" && key === "sendNotification") {
                return (method: string, params: unknown) => {
                  if (method === "workspace/didChangeConfiguration") return Promise.reject(new Error(secret));
                  return target.sendNotification(method, params);
                };
              }
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        };
      }
      await f.manager.start();
      assert.equal(f.failures.length, 1);
      assert.ok(!f.failures[0].includes(secret));
      const expected = { spawn: /could not start/, transport: /connection failed/, clientHandlers: /client handler setup failed/, initialize: /initialization failed/, configuration: /configuration failed/, readyCallback: /ready callback failed/ };
      assert.match(f.failures[0], expected[stage]);
      if (stage === "clientHandlers" || stage === "readyCallback") {
        assert.match(f.failures[0], /integration issue/);
        assert.doesNotMatch(f.failures[0], /installation/);
      }
      assert.equal(f.manager.connection, undefined);
      assert.equal(f.children.length, stage === "spawn" ? 0 : 1);
      for (const child of f.children) {
        assert.ok(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed);
      }
      await f.manager.stop();
      assert.equal(released, ["initialize", "configuration", "readyCallback"].includes(stage) ? 1 : 0);
      assert.equal(f.failures.length, 1);
    });
  }
  it("fails unobtrusively on discovery errors, without spawning", async () => {
    const f = fixture();
    f.host.discover = async () => { throw new Error("private path or token must not be logged"); };
    await f.manager.start();
    assert.equal(f.children.length, 0);
    assert.equal(f.failures.length, 1);
    assert.ok(!f.failures[0].includes("private"));
  });
});
