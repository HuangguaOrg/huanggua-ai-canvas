import hashlib
import importlib.util
import io
import json
from pathlib import Path
import plistlib
import runpy
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("macos_update", Path(__file__).with_name("build-macos-update.py"))
publisher = runpy.run_path(str(Path(__file__).with_name("publish-gitee-update.py")))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class MacUpdateTests(unittest.TestCase):
    def archive(self, folder, version="0.11.11"):
        archive = folder / "app.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            for name, data in {
                "App.app/Contents/Info.plist": plistlib.dumps({"CFBundleShortVersionString": version,
                                                             "CFBundleIdentifier": "com.huanggua.canvas"}),
                "App.app/Contents/MacOS/HuangGuaAI": b"fixture executable",
                "App.app/Contents/_CodeSignature/CodeResources": b"fixture code signature",
            }.items():
                entry = tarfile.TarInfo(name); entry.size = len(data)
                tar.addfile(entry, io.BytesIO(data))
        return archive

    def test_descriptor_authenticates_exact_ordered_archive_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary); archive = self.archive(folder); signed = {}
            def signer(path):
                signed[path.name] = path.read_bytes()
                signature = "signature-for-" + path.name
                path.with_name(path.name + ".sig").write_text(signature)
                return signature
            result = module.build(archive, folder / "out", "0.11.11", "darwin-aarch64", signer, 128)
            joined = b"".join((folder / "out" / part["url"].rsplit("/", 1)[1]).read_bytes() for part in result["parts"])
            self.assertEqual(joined, archive.read_bytes())
            self.assertEqual(result["sha256"], hashlib.sha256(joined).hexdigest())
            for part in result["parts"]:
                data = signed[part["url"].rsplit("/", 1)[1]]
                self.assertEqual(len(data), part["bytes"])
                self.assertEqual(hashlib.sha256(data).hexdigest(), part["sha256"])
            feed = json.loads((folder / "out/latest-macos.json").read_text())
            descriptor_name = feed["platforms"]["darwin-aarch64"]["url"].rsplit("/", 1)[1]
            self.assertEqual(json.loads(signed[descriptor_name]), result)
            self.assertEqual(feed["platforms"]["darwin-aarch64"]["signature"], "signature-for-" + descriptor_name)
            platforms, files = publisher["macos_update_files"](folder / "out", "0.11.11", publisher["DEFAULT_REPO"])
            self.assertEqual(platforms, feed["platforms"])
            self.assertIn(folder / "out" / descriptor_name, files)
            files[0].write_bytes(b"tampered")
            with self.assertRaises(ValueError):
                publisher["macos_update_files"](folder / "out", "0.11.11", publisher["DEFAULT_REPO"])


    def test_resumes_only_identical_remote_files_and_never_publishes_failed_uploads(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary); archive = self.archive(folder)
            def signer(path):
                path.with_name(path.name + ".sig").write_text("fixture-signature")
                return "fixture-signature"
            module.build(archive, folder / "mac", "0.11.11", "darwin-aarch64", signer, 128)
            expected, files = publisher["macos_update_files"](folder / "mac", "0.11.11", publisher["DEFAULT_REPO"])
            opener = Mock()
            opener.open.side_effect = lambda request, **_: io.BytesIO((folder / "mac" / request.full_url.rsplit("/", 1)[1]).read_bytes())
            upload = Mock(side_effect=AssertionError("Existing files must not be overwritten"))
            function = publisher["upload_macos_updates"]
            with patch.dict(function.__globals__, {"gitee_json": lambda *a, **kw: [{"name": p.name} for p in files],
                                                   "_DIRECT_OPENER": opener, "upload_release_attachment": upload}):
                self.assertEqual(function(folder / "mac", "0.11.11", publisher["DEFAULT_REPO"], 1, "fixture"), expected)
                upload.assert_not_called()
                opener.open.side_effect = lambda *a, **kw: io.BytesIO(b"damaged remote attachment")
                with self.assertRaises(ValueError):
                    function(folder / "mac", "0.11.11", publisher["DEFAULT_REPO"], 1, "fixture")
            windows = folder / "windows"; windows.mkdir()
            original = json.dumps({"version": "0.11.11", "platforms": {"windows-x86_64": {"url": "fixture", "signature": "fixture"}}})
            (windows / "latest.json").write_text(original)
            publish = publisher["publish"]; commit = Mock()
            with patch.dict(publish.__globals__, {"ensure_default_branch": lambda *a, **kw: "master",
                "ensure_release": lambda *a: 1, "upload_macos_updates": Mock(side_effect=ValueError("part upload failed")),
                "upsert_repo_file": commit}):
                with self.assertRaises(ValueError):
                    publish(windows, publisher["DEFAULT_REPO"], "fixture", manifest_only=True, macos_dir=folder / "mac")
                commit.assert_not_called()
                self.assertEqual((windows / "latest.json").read_text(), original)

    def test_rejects_wrong_bundle_version_and_preserves_existing_outputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary); archive = self.archive(folder, "0.11.10")
            with self.assertRaises(ValueError):
                module.build(archive, folder / "out", "0.11.11", "darwin-aarch64", lambda _: "unused")
            self.assertFalse((folder / "out").exists())
            archive = self.archive(folder)
            (folder / "out").mkdir(); (folder / "out/keep").write_text("keep")
            with self.assertRaises(FileExistsError):
                module.build(archive, folder / "out", "0.11.11", "darwin-aarch64", lambda _: "unused")
            self.assertEqual((folder / "out/keep").read_text(), "keep")


if __name__ == "__main__":
    unittest.main()
