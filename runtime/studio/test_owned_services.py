"""Ensure engine startup stays local and old hosted endpoints cannot be enabled."""
import asyncio
import logging
import tempfile
import os
from pathlib import Path
import sys
import unittest

sys.path.insert(0, os.environ['HUANGGUA_STUDIO_ENGINE'])
sys.path.insert(0, str(Path(__file__).parent))
from owned_services import install_owned_services, upstream_route


class OwnedServicesTest(unittest.IsolatedAsyncioTestCase):
    async def test_sync_does_not_start_or_read_old_cache(self):
        install_owned_services()
        from lib.catalog import official_sync
        from lib.market import sources
        before = asyncio.all_tasks()
        self.assertIsNone(official_sync.start_official_sync(None))
        self.assertEqual(asyncio.all_tasks(), before)
        await official_sync.load_synced_data(None)
        await official_sync.stop_official_sync(None)
        await sources.seed_official_source(None)
        with self.assertRaisesRegex(ValueError, 'studio_upstream_service_disabled'):
            await official_sync.sync_once(None)
        self.assertEqual(os.environ['ARCREEL_OFFICIAL_SERVICE_URL'], '')

    def test_engine_file_log_uses_product_name_and_preserves_message(self):
        from owned_services import _desktop_log_handler
        with tempfile.TemporaryDirectory() as directory:
            handler = _desktop_log_handler(Path(directory) / 'arcreel.log', when='midnight', encoding='utf-8')
            try:
                handler.setFormatter(logging.Formatter('%(name)s: %(message)s'))
                record = logging.LogRecord('arcreel.worker', logging.INFO, '', 0, 'job %d', (5,), None)
                handler.handle(record)
            finally:
                handler.close()
            self.assertEqual((Path(directory) / 'HuangGuaAI.log').read_text(encoding='utf-8').strip(), 'HuangGuaAI.worker: job 5')
            self.assertEqual(record.name, 'arcreel.worker')

    def test_original_services_blocked_but_local_creation_preserved(self):
        for path in ('/api/v1/market', '/api/v1/market/sources/refresh', '/api/v1/official-service/instance-id/reset', '/api/v1/system/version'):
            self.assertTrue(upstream_route(path))
        for path in ('/api/v1/projects', '/api/v1/system/config', '/desktop/run', '/huanggua-agent/v1/messages'):
            self.assertFalse(upstream_route(path))
