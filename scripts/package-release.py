"""Validate release metadata and build an install-ready ZIP (Python stdlib only)."""
import argparse
import json
from pathlib import Path
import re
import zipfile


def package_release(root, tag):
    def read_json(name):
        return json.loads((root / name).read_text(encoding="utf-8"))

    package = read_json("package.json")
    manifest = read_json("manifest.json")
    lock = read_json("package-lock.json")
    versions = read_json("versions.json")
    version = package["version"]
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
        raise ValueError("Release versions must be stable SemVer: X.Y.Z")
    if tag != version:
        raise ValueError("Tag must exactly match the version (no v prefix)")
    if any(value != version for value in (
        manifest["version"], lock["version"], lock["packages"][""]["version"]
    )):
        raise ValueError("package.json, package-lock.json, and manifest.json versions differ")
    if versions.get(version) != manifest["minAppVersion"]:
        raise ValueError("versions.json must map this version to manifest.minAppVersion")

    plugin_id = manifest["id"]
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", plugin_id):
        raise ValueError("Unsafe plugin ID")
    files = ["main.js", "manifest.json", "LICENSE", "THIRD_PARTY_NOTICES.txt"]
    if (root / "styles.css").exists():
        files.append("styles.css")
    for name in files:
        if not (root / name).is_file() or not (root / name).stat().st_size:
            raise ValueError(f"Missing or empty release file: {name}")

    destination = root / "dist"
    destination.mkdir(exist_ok=True)
    archive_path = destination / f"{plugin_id}-{version}.zip"
    with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in files:
            archive.write(root / name, f"{plugin_id}/{name}")
    # Verify the actual archive, not only the inputs. No settings or dev files ship.
    with zipfile.ZipFile(archive_path) as archive:
        expected = {f"{plugin_id}/{name}" for name in files}
        if set(archive.namelist()) != expected or archive.testzip() is not None:
            raise ValueError("Invalid release archive")
        for name in files:
            if archive.read(f"{plugin_id}/{name}") != (root / name).read_bytes():
                raise ValueError(f"Archive content mismatch: {name}")
    return archive_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True)
    args = parser.parse_args()
    print(package_release(Path.cwd(), args.tag))
