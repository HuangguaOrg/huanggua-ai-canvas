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

    def test_upload_retries_cleanly_and_redacts_token_on_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            payload = Path(temporary) / "HuangGuaAI-0.11.14-windows-x64-update.exe"
            payload.write_bytes(b"signed-update-payload")
            upload_fn = publisher["upload_release_attachment"]
            deleted = []
            calls = []

            def fake_stream(repo, release_id, file_path, token):
                calls.append(file_path.name)
                if len(calls) == 1:
                    raise RuntimeError(f"broken pipe carrying {token}")
                return {"browser_download_url": f"https://gitee.com/{repo}/releases/download/v0.11.14/{file_path.name}"}

            with patch.dict(
                upload_fn.__globals__,
                {
                    "_stream_multipart_once": fake_stream,
                    "_delete_attachment_by_name": lambda repo, rid, name, tok: deleted.append(name),
                    "time": Mock(sleep=lambda *_: None),
                },
            ):
                result = upload_fn(publisher["DEFAULT_REPO"], 99, payload, "secret-token-xyz", max_attempts=2)
                self.assertEqual(
                    result["browser_download_url"],
                    "https://gitee.com/xiang834740239/huanggua-aiagent/releases/download/v0.11.14/HuangGuaAI-0.11.14-windows-x64-update.exe",
                )
                self.assertEqual(deleted, [payload.name])

            with patch.dict(
                upload_fn.__globals__,
                {
                    "_stream_multipart_once": lambda *a: (_ for _ in ()).throw(RuntimeError("leaked secret-token-xyz")),
                    "_delete_attachment_by_name": lambda *a: None,
                    "time": Mock(sleep=lambda *_: None),
                },
            ):
                with self.assertRaises(RuntimeError) as ctx:
                    upload_fn(publisher["DEFAULT_REPO"], 99, payload, "secret-token-xyz", max_attempts=2)
                self.assertNotIn("secret-token-xyz", str(ctx.exception))
                self.assertIn("***", str(ctx.exception))

    def test_prunes_oldest_superseded_release_attachments_while_preserving_live_version(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            part1 = folder / "part1.bin"
            part1.write_bytes(b"x" * (270 * 1024 * 1024) if False else b"abc")
            # Mock stat size logic via fake local files of small real bytes and custom quota_limit_bytes
            f_already = folder / "already.bin"
            f_already.write_bytes(b"a" * 100)
            f_new = folder / "new.bin"
            f_new.write_bytes(b"b" * 300)

            releases = [
                {"id": 10, "tag_name": "v0.11.10"},
                {"id": 11, "tag_name": "v0.11.11"},
                {"id": 13, "tag_name": "v0.11.13"},
                {"id": 14, "tag_name": "v0.11.14"},
            ]
            attachments = {
                10: [{"id": 101, "name": "old10.exe", "size": 150}],
                11: [{"id": 111, "name": "old11.part1", "size": 400}],
                13: [{"id": 131, "name": "live13.part1", "size": 400}],
                14: [{"id": 141, "name": "already.bin", "size": 100}],
            }
            deleted = []

            def fake_api(method, path, token, payload=None, **kw):
                if method == "GET" and path.startswith("/repos/o/r/releases?"):
                    return releases if "page=1" in path else []
                if method == "GET" and path.endswith("/attach_files"):
                    rid = int(path.split("/releases/")[1].split("/")[0])
                    return list(attachments.get(rid, []))
                if method == "DELETE" and "/attach_files/" in path:
                    rid = int(path.split("/releases/")[1].split("/")[0])
                    aid = int(path.rsplit("/", 1)[1])
                    deleted.append((rid, aid))
                    attachments[rid] = [a for a in attachments[rid] if a["id"] != aid]
                    return {}
                raise AssertionError(f"Unexpected API call: {method} {path}")

            quota_fn = publisher["ensure_gitee_quota_headroom"]
            with patch.dict(
                quota_fn.__globals__,
                {
                    "gitee_json": fake_api,
                    "_fetch_current_live_tag": lambda repo, branch: "v0.11.13",
                },
            ):
                # Initial used = 150 + 400 + 400 + 100 = 1050; needed = 300 (new.bin only); limit = 950
                # Pruning rid=10 (150) -> 900 + 300 = 1200 > 950; pruning rid=11 (400) -> 500 + 300 = 800 <= 950!
                # rid=13 (live v0.11.13) and rid=14 (target v0.11.14) must remain untouched!
                quota_fn("o/r", "master", "v0.11.14", [f_already, f_new], "tok", quota_limit_bytes=950)
                self.assertEqual(deleted, [(10, 101), (11, 111)])
                self.assertEqual(len(attachments[13]), 1)
                self.assertEqual(len(attachments[14]), 1)


if __name__ == "__main__":
    unittest.main()
