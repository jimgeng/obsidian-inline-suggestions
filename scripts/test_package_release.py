import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location(
    "package_release", Path(__file__).with_name("package-release.py")
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.put("package.json", {"version": "0.1.0"})
        self.put("manifest.json", {
            "id": "obsidian-inline-suggestions", "version": "0.1.0",
            "minAppVersion": "1.13.0",
        })
        self.put("package-lock.json", {
            "version": "0.1.0", "packages": {"": {"version": "0.1.0"}},
        })
        self.put("versions.json", {"0.1.0": "1.13.0"})
        for name in ("main.js", "LICENSE", "THIRD_PARTY_NOTICES.txt", "data.json", ".env"):
            (self.root / name).write_text("fixture", encoding="utf-8")

    def put(self, name, value):
        (self.root / name).write_text(json.dumps(value), encoding="utf-8")

    def test_install_ready_contents_and_optional_css(self):
        for css in (False, True):
            with self.subTest(css=css):
                if css:
                    (self.root / "styles.css").write_text("/* css */", encoding="utf-8")
                path = module.package_release(self.root, "0.1.0")
                with zipfile.ZipFile(path) as archive:
                    names = {"main.js", "manifest.json", "LICENSE", "THIRD_PARTY_NOTICES.txt"}
                    if css:
                        names.add("styles.css")
                    self.assertEqual(set(archive.namelist()), {
                        f"obsidian-inline-suggestions/{name}" for name in names
                    })
                    for name in names:
                        self.assertEqual(
                            archive.read(f"obsidian-inline-suggestions/{name}"),
                            (self.root / name).read_bytes(),
                        )

    def test_wrong_tag(self):
        for tag in ("v0.1.0", "0.2.0"):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                module.package_release(self.root, tag)

    def test_mismatched_versions(self):
        for filename in ("manifest.json", "package-lock.json"):
            original = (self.root / filename).read_text(encoding="utf-8")
            value = json.loads(original)
            value["version"] = "0.2.0"
            self.put(filename, value)
            with self.subTest(filename=filename), self.assertRaises(ValueError):
                module.package_release(self.root, "0.1.0")
            (self.root / filename).write_text(original, encoding="utf-8")
        self.put("package-lock.json", {
            "version": "0.1.0", "packages": {"": {"version": "0.2.0"}},
        })
        with self.assertRaises(ValueError):
            module.package_release(self.root, "0.1.0")

    def test_missing_compatibility_mapping(self):
        self.put("versions.json", {})
        with self.assertRaises(ValueError):
            module.package_release(self.root, "0.1.0")

    def test_missing_build(self):
        (self.root / "main.js").unlink()
        with self.assertRaises(ValueError):
            module.package_release(self.root, "0.1.0")

    def test_prerelease_rejected(self):
        self.put("package.json", {"version": "0.1.0-beta.1"})
        with self.assertRaises(ValueError):
            module.package_release(self.root, "0.1.0-beta.1")


if __name__ == "__main__":
    unittest.main()
