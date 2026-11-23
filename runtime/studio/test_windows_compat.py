import json
import os
from pathlib import Path
import tempfile
import unittest
from runtime.studio.windows_compat import extended_path, install_resume_paths, install_download_paths


@unittest.skipUnless(os.name == "nt", "Windows resume regression")
class ResumePathsTest(unittest.IsolatedAsyncioTestCase):
    async def test_long_video_checkpoint_and_resume(self):
        import sys
        sys.path.insert(0, os.environ['HUANGGUA_STUDIO_ENGINE'])
        from lib.backends.huanggua_download import VideoDownload
        install_download_paths()
        with tempfile.TemporaryDirectory(dir=extended_path(Path(tempfile.gettempdir()))) as directory:
            # The output fits MAX_PATH; the UUID checkpoint does not.
            root = Path(str(directory).removeprefix('\\\\?\\'))
            output = root / ('p' * 90) / ('v' * 80 + '.mp4')
            download = VideoDownload(output, max_bytes=100, source='test')
            self.assertGreater(len(str(output)) + 42, 260)
            download.total, download.validator = 6, 'test-etag'
            download.append(b'abc')
            restored = VideoDownload(output, max_bytes=100, source='test')
            restored.restore()
            self.assertEqual(restored.offset, 3)
            restored.append(b'def')
            restored.publish()
            self.assertEqual(extended_path(output).read_bytes(), b'abcdef')
            self.assertFalse(restored.checkpoint.exists())

    async def test_long_subagent_resume_preserves_metadata_and_rejects_traversal(self):
        from claude_agent_sdk._internal import session_resume
        install_resume_paths()

        class Store:
            async def list_subkeys(self, key):
                return ["subagents/agent-test", "../escape"]

            async def load(self, key):
                return [{"type": "assistant", "message": {"content": "验收"}},
                        {"type": "agent_metadata", "agentType": "normalize-drama-script"}]

        with tempfile.TemporaryDirectory(dir=extended_path(Path(tempfile.gettempdir()))) as directory:
            root = extended_path(Path(directory))
            project = root / ("p" * 140)
            session = "12345678-1234-1234-1234-123456789012"
            # Add a component to reproduce a path beyond Windows MAX_PATH.
            project = project / ("q" * 70)
            transcript = project / session / "subagents/agent-test.jsonl"
            self.assertGreater(len(str(transcript)), 260)
            await session_resume._materialize_subkeys(Store(), root, project, "key", session, 5)
            self.assertEqual(json.loads(transcript.read_text(encoding="utf-8"))["type"], "assistant")
            self.assertEqual(json.loads(transcript.with_suffix(".meta.json").read_text())["agentType"], "normalize-drama-script")
            self.assertFalse((project / "escape.jsonl").exists())
            await session_resume._rmtree_with_retry(project)
            self.assertFalse(project.exists())
