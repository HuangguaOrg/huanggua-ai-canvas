"""Offline integration checks. Uses an isolated temp data root, never a real account."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

class BridgeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="studio-bridge-test-")
        cls.addClassCleanup(cls.temp.cleanup)
        cls.root = Path(cls.temp.name) / getattr(cls, 'data_suffix', '')
        cls.root.mkdir(parents=True, exist_ok=True)
        cls.token = "offline-test-token"
        cls.process = subprocess.Popen([sys.executable, "-B", "-s", str(Path(__file__).with_name("desktop_bridge.py"))], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8")
        cls.addClassCleanup(cls.stop_process)
        cls.process.stdin.write(json.dumps({"root":os.environ["HUANGGUA_STUDIO_ENGINE"], "data":str(cls.root), "token":cls.token, "session":"offline-invalid"}) + "\n")
        cls.process.stdin.flush()
        cls.port = json.loads(cls.process.stdout.readline())["port"]
        cls.ids = {"projectId":"12345678-1234-1234-1234-123456789012", "episodeId":"12345678-1234-1234-1234-123456789013"}
        for _ in range(100):
            try:
                cls.request("/desktop/poll", cls.ids)
                return
            except OSError:
                if cls.process.poll() is not None:
                    raise RuntimeError("Engine startup failed")
                time.sleep(.2)
        raise RuntimeError("Engine startup timed out")

    @classmethod
    def stop_process(cls):
        cls.process.kill(); cls.process.wait()
        cls.process.stdin.close(); cls.process.stdout.close()

    @classmethod
    def request(cls, path, body=None, token=True, origin=False):
        headers = {"Content-Type":"application/json"}
        if token: headers["Authorization"] = "Bearer " + cls.token
        if origin: headers["Origin"] = "http://untrusted.test"
        request = urllib.request.Request(f"http://127.0.0.1:{cls.port}" + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.read()

    def test_auth_and_origin(self):
        for path, body, token, origin in [("/desktop/poll",self.ids,False,False), ("/desktop/poll",self.ids,True,True), ("/api/v1/projects",None,False,False)]:
            with self.assertRaises(urllib.error.HTTPError) as result:
                self.request(path,body,token,origin)
            self.assertEqual(result.exception.code,403)
            result.exception.close()

    def test_artifact_delivery_and_versions(self):
        project = json.loads(self.request("/desktop/poll",self.ids))["project"]
        folder = self.root / "data/projects" / project / "scripts"
        folder.mkdir(parents=True,exist_ok=True)
        path = folder / "offline-fixture.txt"
        previous_id = None
        for content in (b"first test version", b"revised test version"):
            path.write_bytes(content); os.utime(path,(time.time()-5,time.time()-5))
            result = json.loads(self.request("/desktop/poll",self.ids))
            artifact = next(a for a in result["artifacts"] if a["name"].endswith("offline-fixture.txt"))
            self.assertEqual(artifact["id"],hashlib.sha256(content).hexdigest())
            self.assertEqual(self.request(f"/desktop/artifact/{project}/{artifact['id']}"),content)
            if previous_id:
                with self.assertRaises(urllib.error.HTTPError) as stale:
                    self.request(f"/desktop/artifact/{project}/{previous_id}")
                self.assertEqual(stale.exception.code,409)
                stale.exception.close()
            previous_id = artifact['id']
        with self.assertRaises(urllib.error.HTTPError) as missing:
            self.request(f"/desktop/artifact/{project}/{'0'*64}")
        missing.exception.close()

if __name__ == "__main__": unittest.main()
