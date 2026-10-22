// npm's version lifecycle runs after package.json/package-lock.json are updated.
import { readFile, writeFile } from "node:fs/promises";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const { version } = await readJson("package.json");
const manifest = await readJson("manifest.json");
const versions = await readJson("versions.json");
manifest.version = version;
versions[version] = manifest.minAppVersion;
await writeFile("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
await writeFile("versions.json", JSON.stringify(versions, null, 2) + "\n");
