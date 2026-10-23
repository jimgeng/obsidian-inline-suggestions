import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import * as path from "node:path";

export interface ServerPaths { node: string; server: string }

export const discoveryMessages = {
  invalid_node_path: "Node path must be an absolute path to the Node executable.",
  node_not_found: "Node.js was not found. Install Node.js or set Node path in plugin settings.",
  node_probe_failed: "Node.js could not be run. Check the Node installation and executable permissions.",
  node_version: "Copilot requires Node.js 20.8 or newer.",
  node_resolution_failed: "The Node executable could not be resolved. Check the Node installation.",
  npm_not_found: "npm was not found alongside Node.js or on PATH.",
  npm_probe_failed: "npm could not be run. Check the npm installation.",
  npm_root_invalid: "npm did not return a global package directory.",
  server_not_found: "Copilot language server was not found. Run npm i -g @github/copilot-language-server.",
} as const;

export type DiscoveryErrorCode = keyof typeof discoveryMessages;

export class DiscoveryError extends Error {
  constructor(readonly code: DiscoveryErrorCode) {
    super(discoveryMessages[code]);
    this.name = "DiscoveryError";
  }
}

async function probe<T>(code: DiscoveryErrorCode, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch { throw new DiscoveryError(code); }
}

// Never execute npm.cmd through a shell. Run npm's JS entry point with the
// selected Node instead, so paths containing spaces need no quoting.
export interface DiscoveryHost {
  platform: NodeJS.Platform;
  path: string;
  executable(file: string): Promise<boolean>;
  realpath(file: string): Promise<string>;
  run(file: string, args: string[]): Promise<string>;
}

const host: DiscoveryHost = {
  platform: process.platform,
  path: process.env.PATH ?? "",
  executable: async file => {
    try { await access(file, process.platform === "win32" ? constants.F_OK : constants.X_OK); return true; }
    catch { return false; }
  },
  realpath,
  run: (file, args) => new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error("Node or npm could not be run."));
      else resolve(stdout.trim());
    });
  }),
};

export async function discoverServer(nodeOverride = "", io: DiscoveryHost = host): Promise<ServerPaths> {
  const p = io.platform === "win32" ? path.win32 : path.posix;
  const directories = io.path.split(io.platform === "win32" ? ";" : ":").filter(Boolean)
    .map(directory => directory.replace(/^"(.*)"$/, "$1"));
  let node = nodeOverride.trim();
  if (node && !p.isAbsolute(node)) throw new DiscoveryError("invalid_node_path");
  if (!node) {
    for (const directory of directories) {
      const candidate = p.join(directory, io.platform === "win32" ? "node.exe" : "node");
      if (await probe("node_not_found", () => io.executable(candidate))) { node = candidate; break; }
    }
  }
  if (!node || !await probe("node_not_found", () => io.executable(node))) throw new DiscoveryError("node_not_found");
  const version = await probe("node_probe_failed", () => io.run(node, ["--version"]));
  const match = /^v(\d+)\.(\d+)\./.exec(version);
  if (!match || Number(match[1]) < 20 || (Number(match[1]) === 20 && Number(match[2]) < 8)) {
    throw new DiscoveryError("node_version");
  }
  const resolvedNode = await probe("node_resolution_failed", () => io.realpath(node));
  const npmCandidates = [
    p.join(p.dirname(resolvedNode), "node_modules/npm/bin/npm-cli.js"),
    p.join(p.dirname(resolvedNode), "../lib/node_modules/npm/bin/npm-cli.js"),
  ];
  for (const directory of directories) {
    const launcher = p.join(directory, io.platform === "win32" ? "npm.cmd" : "npm");
    if (io.platform === "win32") npmCandidates.push(p.join(directory, "node_modules/npm/bin/npm-cli.js"));
    else {
      try { npmCandidates.push(await io.realpath(launcher)); } catch { /* Try the next PATH entry. */ }
    }
  }
  let npm: string | undefined;
  for (const candidate of npmCandidates) {
    try { npm = await io.realpath(candidate); break; } catch { /* Not installed here. */ }
  }
  if (!npm) throw new DiscoveryError("npm_not_found");
  const npmPath = npm;
  const root = (await probe("npm_probe_failed", () => io.run(node, [npmPath, "root", "-g"]))).trim();
  if (!p.isAbsolute(root)) throw new DiscoveryError("npm_root_invalid");
  const server = p.join(root, "@github/copilot-language-server/dist/language-server.js");
  try { await io.realpath(server); }
  catch { throw new DiscoveryError("server_not_found"); }
  return { node: resolvedNode, server };
}
