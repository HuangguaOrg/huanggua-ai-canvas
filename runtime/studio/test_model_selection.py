"""Model admission and retry safety without starting a server or calling a model."""
import ast
import asyncio
import hashlib
from types import SimpleNamespace
from unittest.mock import MagicMock
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock


def bridge_functions(**values):
    # The bridge entrypoint starts uvicorn on import; load its actual function
    # definitions with isolated dependencies to exercise the pre-submit boundary.
    source = Path(__file__).with_name('desktop_bridge.py')
    tree = ast.parse(source.read_text(encoding='utf-8'))
    tree.body = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                 and node.name in {'compatible_video_models', 'ensure_project', 'run_episode', 'is_account_bound_key', 'configure_models', 'connect_account', 'desktop_operation'}]
    for node in tree.body:
        node.decorator_list = []
    scope = {'json': json, 're': re, 'Request': object, **values}
    exec(compile(tree, str(source), 'exec'), scope)
    return scope


class ModelSelectionTest(unittest.IsolatedAsyncioTestCase):
    def test_reference_support_does_not_imply_first_frame(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'huanggua-models.json').write_text(json.dumps({'models': [
                {'model_id': 'reference', 'capability_overrides': {'first_frame': False, 'max_reference_images': 9}},
                {'model_id': 'frame', 'capability_overrides': {'first_frame': True, 'max_reference_images': 1}},
                {'model_id': 'unavailable', 'capability_overrides': {'first_frame': True}},
            ]}), encoding='utf-8')
            scope = bridge_functions(ROOT=root, model_refs={'video': {'reference': 'r', 'frame': 'f'}})
            compatible = scope['compatible_video_models']
            self.assertEqual([m['model_id'] for m in compatible('storyboard')], ['frame'])
            self.assertEqual([m['model_id'] for m in compatible('reference_video')], ['reference', 'frame'])

    async def test_definite_rejection_does_not_create_pending_or_send(self):
        for error in ('studio_video_model_incompatible', 'studio_model_unavailable', 'studio_style_required'):
            service = Mock()
            write = Mock()
            scope = bridge_functions(read_binding=lambda _: {}, write_binding=write, get_assistant_service=lambda: service)
            scope['ensure_project'] = AsyncMock(side_effect=ValueError(error))
            identity = '12345678-1234-1234-1234-123456789012'
            reply = await scope['run_episode']('project', {'_binding': 'b', 'requestId': identity, 'content': 'draft'})
            self.assertEqual(reply, {'status': 'rejected', 'error': error, 'requestId': identity})
            write.assert_not_called()
            service.send_or_create.assert_not_called()

    async def test_prior_uncertain_attempt_is_never_released_as_rejected(self):
        identity = '12345678-1234-1234-1234-123456789012'
        scope = bridge_functions(read_binding=lambda _: {'pending': identity}, get_assistant_service=Mock)
        scope['ensure_project'] = AsyncMock(side_effect=ValueError('studio_video_model_incompatible'))
        with self.assertRaisesRegex(ValueError, 'studio_video_model_incompatible'):
            await scope['run_episode']('project', {'_binding': 'b', 'requestId': identity, 'content': 'draft'})

    async def test_accepted_retry_is_acknowledged_before_model_validation(self):
        identity = '12345678-1234-1234-1234-123456789012'
        scope = bridge_functions(read_binding=lambda _: {'lastRequest': identity, 'session_id': 's'})
        scope['ensure_project'] = AsyncMock(side_effect=ValueError('studio_video_model_incompatible'))
        reply = await scope['run_episode']('project', {'_binding': 'b', 'requestId': identity})
        self.assertEqual(reply['status'], 'accepted')
        scope['ensure_project'].assert_not_called()

    async def test_removed_model_is_rejected_before_project_changes(self):
        scope = bridge_functions(model_refs={'video': {'frame': 'f'}}, models={'video': ['frame']})
        with self.assertRaisesRegex(ValueError, 'studio_model_unavailable'):
            await scope['ensure_project']('project', {'models': {'video': 'removed'}})

    async def test_configure_models_binds_three_fixed_account_keys_and_updates_in_place(self):
        calls = []

        class FakeClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

        async def fake_checked(_client, method, path, payload=None):
            calls.append((method, path, payload))
            if method == 'GET' and path == 'custom-providers':
                return {'providers': [
                    {'id': 11, 'display_name': '黄瓜客户端 · text'},
                    {'id': 12, 'display_name': '黄瓜客户端 · image'},
                    {'id': 13, 'display_name': '黄瓜客户端 · video'},
                ]}
            if method == 'PUT' and path.startswith('custom-providers/'):
                return {'id': int(path.split('/')[-1])}
            if method == 'GET' and path == 'agent/credentials':
                return {'credentials': [{'id': 9, 'display_name': '黄瓜客户端 Agent'}]}
            if method == 'PATCH' and path == 'agent/credentials/9':
                return {'id': 9}
            return {}

        key = lambda kind: f"sk-ad1.{'a' * 64}.{kind}.{'b' * 64}"
        text_models = ['claude-sonnet-5-5', 'deepseek-v4.1-flash', 'gemini-pro', 'custom-text-alias', 'gpt-6.2-sol']
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'huanggua-models.json').write_text(json.dumps({'models': [
                {'model_id': 'grsai-gpt-image-2.6', 'display_name': 'img', 'endpoint': 'huanggua-images', 'is_default': True},
                {'model_id': 'grsai-minimax-h3-768p', 'display_name': 'vid', 'endpoint': 'huanggua-video', 'is_default': True},
            ]}), encoding='utf-8')
            scope = bridge_functions(ROOT=root, PORT=9999, models={}, model_refs={}, local_client=FakeClient, checked=fake_checked)
            await scope['configure_models']({
                'text': {'status': 'connected', 'base_url': 'https://huanggua.my', 'api_key': key('text'), 'models': text_models},
                'image': {'status': 'connected', 'base_url': 'https://huanggua.my', 'api_key': key('image'), 'models': ['grsai-gpt-image-2.6']},
                'video': {'status': 'connected', 'base_url': 'https://huanggua.my', 'api_key': key('video'), 'models': ['grsai-minimax-h3-768p']},
            })
            self.assertEqual(scope['models'], {
                'text': text_models,
                'image': ['grsai-gpt-image-2.6'],
                'video': ['grsai-minimax-h3-768p'],
            })
            put_paths = [path for method, path, _ in calls if method == 'PUT']
            self.assertEqual(put_paths, ['custom-providers/11', 'custom-providers/12', 'custom-providers/13'])
            self.assertFalse(any(method == 'POST' and path == 'custom-providers' for method, path, _ in calls))
            text_put = next(payload for method, path, payload in calls if method == 'PUT' and path == 'custom-providers/11')
            self.assertEqual(text_put['api_key'], key('text'))
            self.assertEqual([m['is_default'] for m in text_put['models']], [True, False, False, False, False])
            self.assertEqual([m['model_id'] for m in text_put['models']], text_models)
            self.assertTrue(all(m['endpoint'] == 'anthropic-messages' for m in text_put['models']))
            self.assertEqual(text_put['base_url'], 'https://huanggua.my')
            self.assertEqual(scope['model_refs']['text'], {m: f'custom-11/{m}' for m in text_models})

            # An account with no GPT models must still configure the Agent.
            # Refresh also replaces stale model references instead of retaining them.
            calls.clear()
            await scope['configure_models']({
                'text': {'status': 'connected', 'base_url': 'https://huanggua.my', 'api_key': key('text'),
                         'models': ['deepseek-v4.1-flash']},
            })
            self.assertEqual(scope['models']['text'], ['deepseek-v4.1-flash'])
            self.assertEqual(scope['model_refs']['text'], {'deepseek-v4.1-flash': 'custom-11/deepseek-v4.1-flash'})
            credential = next(p for method, path, p in calls if method == 'PATCH' and path == 'agent/credentials/9')
            for field in ('model', 'haiku_model', 'sonnet_model', 'opus_model', 'subagent_model'):
                self.assertEqual(credential[field], 'deepseek-v4.1-flash')
            defaults = next(p for method, path, p in calls if method == 'PATCH' and path == 'system/config')
            self.assertEqual(set(defaults.values()), {'custom-11/deepseek-v4.1-flash'})

    async def test_configure_models_rejects_legacy_and_mismatched_keys(self):
        class FakeClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

        async def fake_checked(_client, method, path, payload=None):
            return {'providers': []}

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'huanggua-models.json').write_text(json.dumps({'models': []}), encoding='utf-8')
            scope = bridge_functions(ROOT=root, PORT=9999, models={}, model_refs={}, local_client=FakeClient, checked=fake_checked)
            for bad_key in ('sk-legacy-random-token-123456', f"sk-ad1.{'a' * 64}.video.{'b' * 64}"):
                with self.assertRaisesRegex(ValueError, 'studio_account_invalid_response'):
                    await scope['configure_models']({
                        'text': {'status': 'connected', 'base_url': 'https://huanggua.my', 'api_key': bad_key, 'models': ['gpt-5.6']},
                    })


class AccountModelRefreshTest(unittest.IsolatedAsyncioTestCase):
    async def test_status_forces_fresh_account_read(self):
        scope = bridge_functions(connect_account=AsyncMock())
        connect = AsyncMock()
        scope.update(connect_account=connect, models={'text': ['gpt-new']}, compatible_video_models=lambda mode: [])
        result = await scope['desktop_operation']('status', SimpleNamespace(json=AsyncMock(return_value={})))
        connect.assert_awaited_once_with(force=True)
        self.assertEqual(result['models'], {'text': ['gpt-new']})

    async def test_forced_refresh_bypasses_cache_and_failure_invalidates_cache(self):
        services = {'text': {'models': ['gpt-new']}}
        response = Mock()
        response.status_code = 200
        response.json.return_value = {'success': True, 'data': {'expires_at': 2000, 'services': services}}
        remote = MagicMock()
        remote.__aenter__ = AsyncMock(return_value=remote)
        remote.__aexit__ = AsyncMock(return_value=False)
        remote.get = AsyncMock(return_value=response)
        scope = bridge_functions(
            account_lock=asyncio.Lock(), account_checked=99, account_fingerprint='',
            time=SimpleNamespace(monotonic=lambda: 100, time=lambda: 1000),
            httpx=SimpleNamespace(AsyncClient=Mock(return_value=remote)), SESSION='offline-fixture',
            hashlib=hashlib, models={}, model_refs={}, secret_values=set(),
            app=SimpleNamespace(state=SimpleNamespace(generation_worker=SimpleNamespace(start_authorized=AsyncMock()))),
        )
        configure = AsyncMock(); scope['configure_models'] = configure
        await scope['connect_account']()
        remote.get.assert_not_awaited()
        await scope['connect_account'](force=True)
        remote.get.assert_awaited_once()
        configure.assert_awaited_once_with(services)
        remote.get.side_effect = OSError('offline')
        with self.assertRaisesRegex(ValueError, 'studio_account_unavailable'):
            await scope['connect_account'](force=True)
        self.assertEqual(scope['account_checked'], 0)
        remote.get.side_effect = None
        await scope['connect_account']()
        self.assertEqual(remote.get.await_count, 3)

    async def test_account_failures_are_not_all_reported_as_expired_login(self):
        for status, body, configuration_error, expected in (
            (401, {}, None, 'studio_login_required'),
            (403, {}, None, 'studio_account_forbidden'),
            (200, {'success': True, 'data': {'expires_at': 999}}, None, 'studio_login_required'),
            (200, {'success': True, 'data': {}}, None, 'studio_account_invalid_response'),
            (200, {'success': True, 'data': {'expires_at': 2000, 'services': {}}},
             ValueError('studio_text_models_unavailable'), 'studio_text_models_unavailable'),
            (200, {'success': True, 'data': {'expires_at': 2000, 'services': {}}},
             RuntimeError('private internal detail'), 'studio_model_configuration_failed'),
        ):
            with self.subTest(expected=expected):
                response = Mock(status_code=status)
                response.json.return_value = body
                remote = MagicMock()
                remote.__aenter__ = AsyncMock(return_value=remote)
                remote.__aexit__ = AsyncMock(return_value=False)
                remote.get = AsyncMock(return_value=response)
                scope = bridge_functions(
                    account_lock=asyncio.Lock(), account_checked=0, account_fingerprint='old',
                    time=SimpleNamespace(monotonic=lambda: 100, time=lambda: 1000),
                    httpx=SimpleNamespace(AsyncClient=Mock(return_value=remote)), SESSION='fixture',
                    hashlib=hashlib, models={'text': ['old']}, model_refs={'text': {'old': 'old'}},
                    secret_values={'old-key'},
                )
                scope['configure_models'] = AsyncMock(side_effect=configuration_error)
                with self.assertRaisesRegex(ValueError, '^' + expected + '$'):
                    await scope['connect_account'](force=True)
                self.assertEqual(scope['account_checked'], 0)
                self.assertEqual(scope['account_fingerprint'], '')
                self.assertEqual(scope['models'], {})
                self.assertFalse(scope['secret_values'])

    async def test_missing_text_model_reports_catalog_reason_before_configuring_media(self):
        for service, expected in (
            ({'status': 'unavailable', 'models': []}, 'studio_text_models_unavailable'),
            ({'status': 'unavailable', 'models': [], 'error_code': 'model_catalog_unavailable'},
             'studio_text_models_unavailable'),
        ):
            with self.subTest(expected=expected):
                client = Mock()
                scope = bridge_functions(local_client=client)
                with self.assertRaisesRegex(ValueError, '^' + expected + '$'):
                    await scope['configure_models']({'text': service})
                client.assert_not_called()
