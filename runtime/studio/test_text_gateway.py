"""Offline HTTP contract tests; run with the bundled Studio Python."""
import importlib.util
import json
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

HAS_HTTP = all(importlib.util.find_spec(name) for name in ('httpx', 'fastapi'))
if HAS_HTTP:
    import httpx
    from fastapi import FastAPI
    from runtime.studio import text_gateway as gateway


@unittest.skipUnless(HAS_HTTP, 'Use the bundled Studio Python with HTTP dependencies')
class TextGatewayTest(unittest.IsolatedAsyncioTestCase):
    async def call_gateway(self, body, upstream, *, key='fixture-key', peer='127.0.0.1', origin=None):
        app = FastAPI()
        app.include_router(gateway.router, prefix='/huanggua-agent')
        client_type = httpx.AsyncClient
        captured = []

        def client(**options):
            captured.append(options)
            return client_type(transport=httpx.MockTransport(upstream), **options)

        selected = SimpleNamespace(model=body.pop('_selected', 'deepseek-v4.1-flash'), api_key='fixture-key')
        headers = {'x-api-key': key}
        if origin:
            headers['origin'] = origin
        async with client_type(transport=httpx.ASGITransport(app, client=(peer, 1234)), base_url='http://test') as local:
            with patch.object(gateway, 'project_agent_model', AsyncMock(return_value=selected)), \
                 patch.object(gateway.httpx, 'AsyncClient', side_effect=client):
                response = await local.post('/huanggua-agent/projects/test/v1/messages', json=body, headers=headers)
        return response, captured

    async def test_stream_preserves_models_tools_images_and_thinking_without_responses_conversion(self):
        for model in ('claude-sonnet-5-5', 'deepseek-v4.1-flash', 'gemini-pro', 'custom-alias', 'gpt-6.2-sol'):
            with self.subTest(model=model):
                messages = [
                    {'role': 'assistant', 'content': [
                        {'type': 'thinking', 'thinking': 'fixture', 'signature': 'signature'},
                        {'type': 'tool_use', 'id': 'call-1', 'name': 'lookup', 'input': {'id': 1}},
                    ]},
                    {'role': 'user', 'content': [
                        {'type': 'tool_result', 'tool_use_id': 'call-1', 'content': 'ok'},
                        {'type': 'image', 'source': {'type': 'base64', 'media_type': 'image/png', 'data': 'fixture'}},
                    ]},
                ]
                tools = [{'name': 'lookup', 'input_schema': {'type': 'object'}}]
                events = [
                    {'type': 'message_start', 'message': {'model': model}},
                    {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'tool_use', 'id': 'call-2', 'name': 'lookup', 'input': {}}},
                    {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': '{"id":2}'}},
                    {'type': 'content_block_stop', 'index': 0},
                    {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use'}},
                    {'type': 'message_stop'},
                ]
                stream = ''.join(f"event: {e['type']}\ndata: {json.dumps(e)}\n\n" for e in events)
                requests = []

                def upstream(request):
                    requests.append(request)
                    payload = json.loads(request.content)
                    self.assertEqual(str(request.url), 'https://huanggua.my/v1/messages')
                    self.assertEqual(payload['model'], model)
                    self.assertEqual(payload['messages'], messages)
                    self.assertEqual(payload['tools'], tools)
                    self.assertNotIn('context_management', payload)
                    self.assertNotIn('output_config', payload)
                    self.assertEqual(payload['system'][0]['text'], 'original system')
                    self.assertIn(model, payload['system'][-1]['text'])
                    return httpx.Response(200, text=stream, headers={'content-type': 'text/event-stream'})

                response, clients = await self.call_gateway({
                    '_selected': model, 'model': 'stale-model', 'messages': messages,
                    'tools': [{**tools[0], 'type': 'custom', 'defer_loading': True}],
                    'context_management': {'edits': [{'type': 'clear_thinking_20251015'}]},
                    'output_config': {'effort': 'high'},
                    'system': [{'type': 'text', 'text': 'original system'}], 'stream': True, 'max_tokens': 256,
                }, upstream)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.text, stream)
                self.assertEqual(len(requests), 1)
                self.assertEqual(clients, [{'timeout': None, 'trust_env': False, 'follow_redirects': False}])

    async def test_credentials_origin_and_peer_are_checked_before_upstream(self):
        for options in ({'key': 'stale'}, {'key': ''}, {'origin': 'https://untrusted.test'}, {'peer': '192.0.2.1'}):
            response, clients = await self.call_gateway({'model': 'm', 'messages': []}, None, **options)
            self.assertIn(response.status_code, (401, 403))
            self.assertEqual(clients, [])

    async def test_nonstream_and_failure_do_not_retry_or_expose_credentials(self):
        raw = {'type': 'message', 'content': [{'type': 'text', 'text': 'OK'}], 'stop_reason': 'end_turn'}
        response, _ = await self.call_gateway({'model': 'm', 'messages': []}, lambda _: httpx.Response(200, json=raw))
        self.assertEqual(response.json(), raw)
        calls = []

        def unavailable(request):
            calls.append(request)
            return httpx.Response(503, json={'error': {'message': 'unavailable fixture-key sk-another-secret'}})

        response, _ = await self.call_gateway({'model': 'm', 'messages': []}, unavailable)
        self.assertEqual(response.status_code, 503)
        self.assertNotIn('fixture-key', response.text)
        self.assertNotIn('sk-another-secret', response.text)
        self.assertEqual(len(calls), 1)

    async def test_interrupted_stream_is_an_error_not_success(self):
        response, _ = await self.call_gateway({'model': 'm', 'messages': [], 'stream': True},
            lambda _: httpx.Response(200, text='event: message_start\ndata: {"type":"message_start"}\n\n'))
        self.assertIn('event: error', response.text)
        self.assertNotIn('message_stop', response.text)

    async def test_terminal_event_finishes_without_waiting_for_connection_close(self):
        for event_type in ('message_stop', 'error'):
            with self.subTest(event_type=event_type):
                frame = f'event: {event_type}\ndata: {{"type":\ndata: "{event_type}"}}\n\n'

                class Stream(httpx.AsyncByteStream):
                    closed = False

                    async def __aiter__(self):
                        yield frame.encode()
                        raise AssertionError('Must stop reading at the terminal event')

                    async def aclose(self):
                        self.closed = True

                stream = Stream()
                response, _ = await self.call_gateway({'model': 'm', 'messages': [], 'stream': True},
                    lambda _: httpx.Response(200, stream=stream))
                self.assertEqual(response.text, frame)
                self.assertTrue(stream.closed)

    async def test_project_model_enforces_provider_endpoint_and_enabled_state(self):
        class Session:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *args):
                return False

        provider = SimpleNamespace(base_url='https://huanggua.my', api_key='fixture-key')
        model = SimpleNamespace(model_id='deepseek-v4.1-flash', is_enabled=True, endpoint='anthropic-messages')
        repo = SimpleNamespace(get_provider=AsyncMock(return_value=provider), get_model_by_ids=AsyncMock(return_value=model))
        engine = SimpleNamespace(
            ConfigResolver=lambda _: SimpleNamespace(agent_text_backend=AsyncMock(return_value=('custom-11', model.model_id))),
            async_session_factory=Session, is_custom_provider=lambda _: True, parse_provider_id=lambda _: 11,
            CustomProviderRepository=lambda _: repo, ProjectAgentModel=SimpleNamespace,
        )
        with patch.dict('sys.modules', {'server.agent_runtime': SimpleNamespace(huanggua_model=engine)}):
            selected = await gateway.project_agent_model('test')
            self.assertEqual(selected.model, model.model_id)
            for field, bad in (('is_enabled', False), ('endpoint', 'huanggua-video')):
                previous = getattr(model, field)
                setattr(model, field, bad)
                with self.assertRaises(ValueError):
                    await gateway.project_agent_model('test')
                setattr(model, field, previous)
            provider.base_url = 'https://untrusted.test'
            with self.assertRaises(ValueError):
                await gateway.project_agent_model('test')
