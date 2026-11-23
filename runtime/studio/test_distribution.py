"""Offline release dependency restoration: trust boundary and non-overwrite."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SPEC = importlib.util.spec_from_file_location('restore_desktop_runtime', Path(__file__).resolve().parents[2] / 'scripts/restore-desktop-runtime.py')
restore = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(restore)


DELTA_SPEC = importlib.util.spec_from_file_location('build_incremental_update', Path(__file__).resolve().parents[2] / 'scripts/build-incremental-update.py')
delta = importlib.util.module_from_spec(DELTA_SPEC)
DELTA_SPEC.loader.exec_module(delta)


class IncrementalDistributionTest(unittest.TestCase):
    def test_reverted_and_new_resources_are_carried_across_releases(self):
        baseline = {'runtime': 'original', 'director': 'same'}
        reuse, carried = delta.plan_resources(dict(baseline, runtime='revision', new='added'), baseline, set())
        self.assertEqual(reuse, {'director': 'same'})
        reuse, carried = delta.plan_resources(dict(baseline, new='added'), baseline, set(carried))
        self.assertEqual(reuse, {'director': 'same'})
        self.assertEqual(carried, ['new', 'runtime'])
        with self.assertRaisesRegex(ValueError, 'cleanup'):
            delta.plan_resources(baseline, baseline, set(carried))

    def test_later_releases_require_history_from_the_same_baseline(self):
        base_id = 'b' * 64
        with tempfile.TemporaryDirectory() as folder:
            feed = Path(folder) / 'latest.json'
            feed.write_text(json.dumps({'version': '0.11.7', 'huangguaDelta': {
                'baseSha256': base_id, 'carriedResources': ['director-desk.tar.gz']}}))
            self.assertEqual(delta.carried_from_previous('0.11.9', '0.11.7', base_id, feed), {'director-desk.tar.gz'})
            with self.assertRaisesRegex(ValueError, 'previous'):
                delta.carried_from_previous('0.11.7', '0.11.7', base_id, feed)
            with self.assertRaisesRegex(ValueError, 'incompatible'):
                delta.carried_from_previous('0.11.8', '0.11.7', 'c' * 64, feed)
            feed.write_text(json.dumps({'version': '0.11.7'}))
            with self.assertRaisesRegex(ValueError, 'incompatible'):
                delta.carried_from_previous('0.11.8', '0.11.7', base_id, feed)

    def test_baseline_identity_is_order_independent(self):
        first = {'huanggua-studio.zip': 'a' * 64, 'director-desk.tar.gz': 'b' * 64}
        self.assertEqual(delta.canonical_id(first), delta.canonical_id(dict(reversed(list(first.items())))))
        self.assertNotEqual(delta.canonical_id(first), delta.canonical_id(dict(first, **{'huanggua-studio.zip': 'c' * 64})))

    def test_gitee_feed_falls_back_from_master_to_main_on_404(self):
        self.assertEqual(delta.GITEE_REPO, 'xiang834740239/huanggua-aiagent')
        self.assertEqual(
            delta.CHANNEL,
            'https://gitee.com/xiang834740239/huanggua-aiagent/releases/download',
        )
        calls = []

        def fake_urlopen(req, timeout=0):
            calls.append(req.full_url)
            if req.full_url.endswith('/raw/master/latest.json'):
                raise delta.urllib.error.HTTPError(req.full_url, 404, 'Not Found', {}, None)
            return io.BytesIO(b'{"version":"0.11.7"}')

        with patch.object(delta.urllib.request, 'urlopen', side_effect=fake_urlopen):
            feed = delta.fetch_remote_feed()
        self.assertEqual(feed['version'], '0.11.7')
        self.assertEqual(
            calls,
            [
                'https://gitee.com/xiang834740239/huanggua-aiagent/raw/master/latest.json',
                'https://gitee.com/xiang834740239/huanggua-aiagent/raw/main/latest.json',
            ],
        )


PACKAGE_SPEC = importlib.util.spec_from_file_location('package_studio_runtime', Path(__file__).resolve().parents[2] / 'scripts/package-studio-runtime.py')
package = importlib.util.module_from_spec(PACKAGE_SPEC)
PACKAGE_SPEC.loader.exec_module(package)


class RuntimePruningTest(unittest.TestCase):
    def test_only_unused_volcengine_services_and_gui_data_are_pruned(self):
        for kept in ('volcenginesdkcore', 'volcenginesdkark', 'volcenginesdkarkruntime', 'openai', 'volcengine'):
            self.assertFalse(package.pruned(f'python/Lib/site-packages/{kept}'), kept)
        for removed in ('volcenginesdkecs', 'volcenginesdkvod20260101', 'volcenginesdkcdn'):
            self.assertTrue(package.pruned(f'python/Lib/site-packages/{removed}'), removed)
        self.assertTrue(package.pruned('python/tcl'))
        self.assertTrue(package.pruned('python/include'))
        self.assertFalse(package.pruned('python/Lib'))
        self.assertFalse(package.pruned('engine/lib/volcenginesdkecs'))


@unittest.skipUnless(restore.os.name == 'nt', 'Windows dependency distribution')
class DistributionTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / 'runtime/studio').mkdir(parents=True)
        self.root_patch = patch.object(restore, 'ROOT', self.root)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)

    def fixture(self, names=(), *, invalid_hash=False, foreign_source=False):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            archive.writestr('huanggua-studio/engine/server/app.py', 'fixture')
            archive.writestr('director-desk.tar.gz', 'fixture director')
            for name in names:
                archive.writestr(name, 'untrusted')
        content = buffer.getvalue()
        lock = {'schemaVersion': 1, 'platform': 'windows-x86_64',
                'url': 'https://github.com/HuangguaOrg/AI-Canvas-tauri/releases/download/runtime-test/runtime.zip',
                'sha256': '0' * 64 if invalid_hash else hashlib.sha256(content).hexdigest()}
        if foreign_source:
            lock['url'] = lock['url'].replace('HuangguaOrg', 'OtherOrg')
        (self.root / 'runtime/studio/distribution.json').write_text(json.dumps(lock), encoding='utf-8')
        return patch.object(restore.urllib.request, 'urlopen', return_value=io.BytesIO(content))

    def test_verified_archive_restores_to_owned_resources(self):
        with self.fixture(), patch('builtins.print'):
            restore.restore()
        self.assertEqual((self.root / 'src-tauri/resources/huanggua-studio/engine/server/app.py').read_text(), 'fixture')

    def test_hash_failure_leaves_no_resources(self):
        with self.fixture(invalid_hash=True), self.assertRaisesRegex(ValueError, 'digest mismatch'):
            restore.restore()
        self.assertFalse((self.root / 'src-tauri/resources').exists())

    def test_foreign_source_rejected_before_network(self):
        with self.fixture(foreign_source=True) as network, self.assertRaisesRegex(ValueError, 'Untrusted'):
            restore.restore()
        network.assert_not_called()

    def test_existing_installation_is_not_overwritten(self):
        resources = self.root / 'src-tauri/resources/huanggua-studio'
        resources.mkdir(parents=True)
        (resources / 'sentinel').write_text('preserve')
        with self.fixture() as network, self.assertRaisesRegex(ValueError, 'already exist'):
            restore.restore()
        network.assert_not_called()
        self.assertEqual((resources / 'sentinel').read_text(), 'preserve')

    def test_unsafe_entries_rejected_without_extraction(self):
        for name in ('huanggua-studio/../../escape', '/outside', 'huanggua-studio/C:drive',
                     'huanggua-studio/engine/server/APP.PY', 'huanggua-studio/file.', 'huanggua-studio/./alias'):
            with self.subTest(name=name), self.fixture([name]), self.assertRaisesRegex(ValueError, 'Unsafe'):
                restore.restore()
            self.assertFalse((self.root / 'src-tauri/resources').exists())
