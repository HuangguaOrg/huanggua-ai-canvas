"""Desktop conversation boundary regressions; no model or user data is used."""
import base64
import io
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock

from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from workspace_api import workspace
from conversation_api import attachment_path, attachment_meta, queued_display, normalize_session_entries, save_attachment


def meta(identity, superseded=None):
    return SimpleNamespace(id=identity, project_name='project', status='completed', superseded_by=superseded,
                           model_dump=lambda **_: {'id': identity, 'title': 'internal context', 'status': 'completed', 'created_at': '2026-11-17T12:00:00Z'})


class ConversationTest(unittest.IsolatedAsyncioTestCase):
    async def test_withdraw_retains_images_as_private_references(self):
        with tempfile.TemporaryDirectory() as folder:
            buffer = io.BytesIO(); Image.new('RGB', (32, 32), 'green').save(buffer, 'PNG')
            message = {'id': 'message', 'content': [{'type': 'text', 'text': 'private context\n本轮制作要求：\n用户草稿'},
                       {'type': 'image', 'source': {'type': 'base64', 'data': base64.b64encode(buffer.getvalue()).decode()}}]}
            service = SimpleNamespace(get_session=AsyncMock(return_value=meta('session')),
                                      withdraw_queued_message=AsyncMock(return_value={'outcome': 'withdrawn', 'message': message}))
            body = {'action': 'queue_edit', 'id': 'message', '_binding': 'binding', '_data_root': Path(folder)}
            result = await workspace('project', body, None, None, service, lambda _: {'session_id': 'session'}, lambda *_: None)
            self.assertEqual(result['message']['text'], '用户草稿')
            self.assertNotIn('content', result['message'])
            reference = result['message']['attachments'][0]
            self.assertEqual(set(reference), {'id', 'name'})
            self.assertTrue(attachment_path(Path(folder), 'binding', reference['id']).is_file())
            with self.assertRaises(ValueError):
                attachment_path(Path(folder), 'other-episode', reference['id'])
            service.withdraw_queued_message.assert_awaited_once_with('project', 'session', 'message', intent='edit')

    async def test_queue_preview_keeps_original_attachment_metadata(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            buffer = io.BytesIO()
            image = Image.new('RGB', (32, 32))
            image.putdata([((i * 17) % 256, (i * 37) % 256, (i * 71) % 256) for i in range(1024)])
            image.save(buffer, 'PNG')
            ref = save_attachment(root, 'binding', buffer, filename='original.png', project_dir=root)
            preview = attachment_path(root, 'binding', ref['id']).read_bytes()
            message = {'id': 'message', 'content': [{'type': 'image', 'source': {
                'type': 'base64', 'data': base64.b64encode(preview).decode()}}]}
            restored = queued_display(root, 'binding', message)
            self.assertEqual(restored['attachments'][0]['id'], ref['id'])
            self.assertEqual(attachment_meta(root, 'binding', ref['id'])['project_path'], ref['projectPath'])
            self.assertEqual((root / ref['projectPath']).read_bytes(), buffer.getvalue())

    async def test_superseded_history_stays_visible_without_foreign_sessions(self):
        binding = {'session_id': 'new', 'sessions': ['old', 'new']}
        metas = {'old': meta('old', 'new'), 'new': meta('new'), 'foreign': meta('foreign')}
        service = SimpleNamespace(get_session=AsyncMock(side_effect=lambda identity: metas.get(identity)),
                                  list_session_entries=AsyncMock(return_value={'entries': [{'type': 'user', 'content': [{'type': 'text', 'text': 'context\n本轮制作要求：\n用户要求'}]}]}))
        def save(_, value):
            binding.clear(); binding.update(value)
        result = await workspace('project', {'action': 'sessions'}, None, None, service, lambda _: dict(binding), save)
        self.assertEqual({r['id'] for r in result['sessions']}, {'old', 'new'})
        self.assertTrue(next(r for r in result['sessions'] if r['id'] == 'old')['superseded'])
        self.assertTrue(all(r['title'] == '用户要求' for r in result['sessions']))
        await workspace('project', {'action': 'sessions'}, None, None, service, lambda _: dict(binding), save)
        self.assertEqual(service.list_session_entries.await_count, 2)  # cached titles avoid rereading transcripts
        await workspace('project', {'action': 'session_select', 'id': 'old'}, None, None, service, lambda _: dict(binding), save)
        self.assertEqual(binding['session_id'], 'old')
        with self.assertRaises(ValueError):
            await workspace('project', {'action': 'session_select', 'id': 'foreign'}, None, None, service, lambda _: dict(binding), save)

    def test_normalize_session_entries_strips_subagents_cutoffs_and_secrets(self):
        raw = [
            {
                'uuid': 'user-root-1',
                'type': 'user',
                'content': [{'type': 'text', 'text': '内部前缀\n本轮制作要求：\n帮我制作第一集 secret-tok'}],
            },
            {
                'uuid': 'sub-user-1',
                'type': 'user',
                'parent_tool_use_id': 'toolu_sub_1',
                'content': [{'type': 'text', 'text': '子智能体内部提示词'}],
            },
            {
                'uuid': 'sub-asst-1',
                'type': 'assistant',
                'parent_tool_use_id': 'toolu_sub_1',
                'content': [{'type': 'tool_use', 'name': 'ToolSearch'}],
            },
            {
                'uuid': 'asst-cut-1',
                'type': 'assistant',
                'content': [{'type': 'text', 'text': '被截断的半句话'}],
            },
            {
                'uuid': 'cli-cut-1',
                'type': 'user',
                'content': [
                    {
                        'type': 'text',
                        'text': 'Your response above was cut off mid-stream and only your next message is delivered. Write the complete response again from the start — no apology, no mention of the cut-off.',
                    }
                ],
            },
            {
                'uuid': 'compact-1',
                'type': 'user',
                'subtype': 'compact_summary',
                'content': [{'type': 'text', 'text': 'This session is being continued...'}],
            },
            {
                'uuid': 'asst-final',
                'type': 'assistant',
                'content': [
                    {'type': 'tool_use', 'name': 'mcp__arcreel__generate_videos', 'input': {'scene_ids': ['E1S01', 'E1S02']}},
                    {'type': 'text', 'text': '已完成提交 secret-tok'},
                ],
            },
            {
                'uuid': 'qa-1',
                'type': 'user',
                'subtype': 'question_answer',
                'answers': {'镜头节奏': '快节奏卡点'},
                'content': '镜头节奏: 快节奏卡点',
            },
        ]
        cleaned = normalize_session_entries(raw, secrets=('secret-tok',))
        self.assertEqual([e['uuid'] for e in cleaned], ['user-root-1', 'asst-final', 'qa-1'])
        self.assertTrue(cleaned[0]['rewritable'])
        self.assertEqual(cleaned[0]['content'][0]['text'], '帮我制作第一集 [REDACTED]')
        self.assertEqual(
            cleaned[1]['content'][0],
            {'type': 'tool_use', 'name': 'mcp__arcreel__generate_videos', 'detail': 'E1S01, E1S02'},
        )
        self.assertEqual(cleaned[1]['content'][1]['text'], '已完成提交 [REDACTED]')
        self.assertFalse(cleaned[2]['rewritable'])
        self.assertEqual(cleaned[2]['subtype'], 'question_answer')
        self.assertEqual(cleaned[2]['content'][0]['text'], '已确认：快节奏卡点')




class AttachmentPersistenceTest(unittest.TestCase):
    def test_unavailable_project_never_reports_success_or_creates_preview(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ('reference.png', 'reference.webm'):
                with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'studio_project_storage_unavailable'):
                    save_attachment(root, 'binding', io.BytesIO(b'fixture'), filename=name, project_dir=root / 'missing')
            self.assertFalse((root / 'attachments').exists())

    def test_successful_image_attachment_retains_original_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            project = root / 'project'
            project.mkdir()
            buffer = io.BytesIO()
            Image.new('RGBA', (8, 8), (0, 255, 0, 128)).save(buffer, 'PNG')
            raw = buffer.getvalue()
            result = save_attachment(root, 'binding', io.BytesIO(raw), filename='reference.png', project_dir=project)
            self.assertEqual((project / result['projectPath']).read_bytes(), raw)


if __name__ == '__main__':
    unittest.main()
