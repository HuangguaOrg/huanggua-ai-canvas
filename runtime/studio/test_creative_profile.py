"""Verify the original profile is retained and the creative entry is projected."""
from pathlib import Path
import tempfile
import unittest
from runtime.studio.creative_profile import prepare_profile, desktop_profile_text


class CreativeProfileTest(unittest.TestCase):
    def test_versioned_extension_retains_upstream_and_does_not_modify_it(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            upstream = root / 'engine/agent_runtime_profile'
            workflow = upstream / '.claude/skills/video-workflow/SKILL.drama.md'
            workflow.parent.mkdir(parents=True)
            workflow.write_text('ArcReel 工作流 mcp__arcreel__get_project_content', encoding='utf-8')
            persona = upstream / 'CLAUDE.drama.md'
            persona.write_text('original persona', encoding='utf-8')
            other = upstream / '.claude/agents/existing.md'
            other.parent.mkdir()
            other.write_text('existing agent', encoding='utf-8')
            resources = Path(__file__).parent
            profile = prepare_profile(root / 'engine', root / 'data', resources)
            self.assertEqual(other.read_text(encoding='utf-8'), (profile / '.claude/agents/existing.md').read_text(encoding='utf-8'))
            self.assertEqual(persona.read_text(encoding='utf-8'), 'original persona')
            self.assertIn('original-story', (profile / 'CLAUDE.drama.md').read_text(encoding='utf-8'))
            self.assertIn('你是黄瓜 AI 客户端内的短剧助手', (profile / 'CLAUDE.drama.md').read_text(encoding='utf-8'))
            self.assertIn('HuangGuaAI 工作流 mcp__arcreel__get_project_content', (profile / workflow.relative_to(upstream)).read_text(encoding='utf-8'))
            self.assertTrue((profile / '.claude/agents/write-original-story.md').is_file())
            self.assertTrue((profile / '.claude/skills/original-story/SKILL.md').is_file())
            self.assertEqual(profile, prepare_profile(root / 'engine', root / 'data', resources))
            workflow.write_text('updated upstream workflow', encoding='utf-8')
            updated = prepare_profile(root / 'engine', root / 'data', resources)
            self.assertNotEqual(profile, updated)
            self.assertTrue((profile / 'CLAUDE.drama.md').exists())


class DesktopProfileTest(unittest.TestCase):
    def test_unavailable_web_actions_are_not_renamed_into_fake_desktop_actions(self):
        result = desktop_profile_text('请用户在 Web 端「分集」视图里操作。只能由用户在 Web 端「文件」视图里操作。')
        self.assertNotIn('Web 端', result)
        self.assertIn('尚未提供', result)
        self.assertIn('暂不支持', result)

    def test_embedded_batch_contract_waits_for_terminal_response(self):
        result = desktop_profile_text('一次调用完成入队并返回 durable batch；按返回的 `poll_after_seconds` 调用 `get_generation_batch`，直到 `done: true` 后再处理结果：')
        self.assertIn('等待批次终态后返回', result)
        self.assertIn('仅当', result)
