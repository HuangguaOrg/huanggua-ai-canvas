import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.environ['HUANGGUA_STUDIO_ENGINE'])
from runtime.studio.account_worker import AccountBoundGenerationWorker


class AccountWorkerTest(unittest.IsolatedAsyncioTestCase):
    async def test_recovery_waits_for_authorization_and_only_starts_once(self):
        # Observe the real worker lifecycle without touching a queue or provider.
        recovery_started = asyncio.Event()
        finish = asyncio.Event()
        calls = []

        class ObservedWorker(AccountBoundGenerationWorker):
            async def _run_loop(self):
                calls.append('recover')
                recovery_started.set()
                await finish.wait()

        worker = ObservedWorker(executor=None, resume_executor=None)
        await worker.start()
        await asyncio.sleep(0)
        self.assertFalse(recovery_started.is_set())
        await worker.stop()  # Failed/offline login can shut down without a deadlock.
        await worker.start_authorized()
        await asyncio.wait_for(recovery_started.wait(), 1)
        await worker.start_authorized()
        await asyncio.sleep(0)
        self.assertEqual(calls, ['recover'])
        finish.set()
        await worker.stop()


if __name__ == '__main__':
    unittest.main()
