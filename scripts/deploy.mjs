import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function deploy() {
  try {
    loadEnvFile(join(root, ".env"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("Create .env from .env.example and set OBSIDIAN_VAULT_PATH.");
    }
    throw error;
  }

  const vaultPath = process.env.OBSIDIAN_VAULT_PATH?.trim();
  if (!vaultPath) {
    throw new Error("Set OBSIDIAN_VAULT_PATH in .env to your vault root.");
  }

  const configDir = resolve(root, vaultPath, ".obsidian");
  const configStat = await stat(configDir).catch((error) => {
    if (error.code === "ENOENT") {
      throw new Error(`No .obsidian folder found at ${configDir}. Check OBSIDIAN_VAULT_PATH.`);
    }
    throw error;
  });
  if (!configStat.isDirectory()) {
    throw new Error(`Expected a directory at ${configDir}.`);
  }

  const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
  const destination = join(configDir, "plugins", manifest.id);
  await mkdir(destination, { recursive: true });
  for (const file of ["main.js", "manifest.json", "styles.css"]) {
    // Obsidian styles are optional; do not delete any existing plugin files.
    if (file === "styles.css") {
      try {
        await stat(join(root, file));
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
    }
    await copyFile(join(root, file), join(destination, file));
  }
  console.log(`Deployed ${manifest.name} to ${destination}`);
}

deploy().catch((error) => {
  console.error(`Deployment failed: ${error.message}`);
  process.exitCode = 1;
});
