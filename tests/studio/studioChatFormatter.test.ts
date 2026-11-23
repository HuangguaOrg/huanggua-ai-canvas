import { describe, expect, it } from 'vitest';
import {
  classifyStudioTool,
  formatStudioTaskType,
  groupStudioChatTurns,
  summarizeActionSteps,
} from '../../src/components/studio/studioChatFormatter';
import type { StudioEntry } from '../../src/types/studio';

describe('studioChatFormatter', () => {
  it('hides internal harness tools and translates creative tools into concise Chinese labels', () => {
    expect(classifyStudioTool('ToolSearch')).toEqual({ kind: 'hidden', label: '' });
    expect(classifyStudioTool('TodoWrite')).toEqual({ kind: 'hidden', label: '' });
    expect(classifyStudioTool('AskUserQuestion')).toEqual({ kind: 'hidden', label: '' });

    expect(classifyStudioTool('Read')).toEqual({ kind: 'plumbing', label: '读取项目文件' });
    expect(classifyStudioTool('mcp__arcreel__get_generation_batch')).toEqual({
      kind: 'plumbing',
      label: '同步生成进度',
    });

    expect(classifyStudioTool('mcp__arcreel__generate_videos', 'E1S01, E1S02')).toEqual({
      kind: 'action',
      label: '提交生成镜头视频（E1S01, E1S02）',
    });
    expect(classifyStudioTool('mcp__arcreel__create_character', '林晚')).toEqual({
      kind: 'action',
      label: '创建角色「林晚」',
    });
    expect(classifyStudioTool('Task', 'create-episode-script')).toEqual({
      kind: 'action',
      label: '编写分镜与视频提示词',
    });
  });

  it('filters stream-cutoff retry prompts and drops truncated partial assistant text before retry', () => {
    const entries: StudioEntry[] = [
      {
        uuid: 'user-abc123',
        type: 'user',
        content: [{ type: 'text', text: '系统上下文\n本轮制作要求：\n帮我生成第一集全部视频' }],
      },
      {
        uuid: 'asst-partial-1',
        type: 'assistant',
        content: [{ type: 'text', text: '好的，我现在开始准备第' }],
      },
      {
        uuid: 'cli-retry-1',
        type: 'user',
        content: [
          {
            type: 'text',
            text: 'Your response above was cut off mid-stream and only your next message is delivered. Write the complete response again from the start — no apology, no mention of the cut-off.',
          },
        ],
      },
      {
        uuid: 'asst-partial-2',
        type: 'assistant',
        content: [{ type: 'text', text: '好的，我现在开始准备第一集的' }],
      },
      {
        uuid: 'cli-retry-2',
        type: 'user',
        content: [
          {
            type: 'text',
            text: 'Your response above was cut off mid-stream and only your next message is delivered. Write the complete response again from the start — no apology, no mention of the cut-off.',
          },
        ],
      },
      {
        uuid: 'asst-tool-search',
        type: 'assistant',
        content: [{ type: 'tool_use', name: 'ToolSearch' }],
      },
      {
        uuid: 'asst-poll',
        type: 'assistant',
        content: [{ type: 'tool_use', name: 'mcp__arcreel__get_project' }],
      },
      {
        uuid: 'asst-gen',
        type: 'assistant',
        content: [{ type: 'tool_use', name: 'mcp__arcreel__generate_videos', detail: 'E1S01 等 4 项' }],
      },
      {
        uuid: 'asst-final',
        type: 'assistant',
        content: [{ type: 'text', text: '已为你提交 4 个镜头的视频生成任务。' }],
      },
    ];

    const turns = groupStudioChatTurns(entries, null, false);
    expect(turns).toHaveLength(2);

    expect(turns[0]).toMatchObject({
      kind: 'user',
      uuid: 'user-abc123',
      rewritable: true,
      isQuestionAnswer: false,
      texts: ['帮我生成第一集全部视频'],
    });

    expect(turns[1]).toMatchObject({
      kind: 'assistant',
      actionSteps: [{ label: '提交生成镜头视频（E1S01 等 4 项）', count: 1 }],
      blocks: [{ type: 'text', text: '已为你提交 4 个镜头的视频生成任务。', isError: false }],
    });
  });

  it('merges consecutive identical action steps, renders question answers without rewrite, and shows plumbing hint while running', () => {
    const entries: StudioEntry[] = [
      {
        uuid: 'qa-1',
        type: 'user',
        subtype: 'question_answer',
        rewritable: false,
        content: [{ type: 'text', text: '已确认：写实电影感' }],
      },
      {
        uuid: 'asst-1',
        type: 'assistant',
        content: [
          { type: 'tool_use', name: 'mcp__arcreel__generate_storyboards' },
          { type: 'tool_use', name: 'mcp__arcreel__generate_storyboards' },
          { type: 'tool_use', name: 'mcp__arcreel__generate_videos' },
        ],
      },
    ];

    const completed = groupStudioChatTurns(entries, null, false);
    expect(completed).toHaveLength(2);
    expect(completed[0]).toMatchObject({
      kind: 'user',
      isQuestionAnswer: true,
      rewritable: false,
      texts: ['已确认：写实电影感'],
    });
    if (completed[1].kind === 'assistant') {
      expect(completed[1].actionSteps).toHaveLength(2);
      expect(completed[1].actionSteps[0]).toMatchObject({ label: '生成分镜画面', count: 2 });
      expect(summarizeActionSteps(completed[1].actionSteps)).toBe('生成分镜画面 ×2 → 提交生成镜头视频');
    }

    const runningOnlyPlumbing = groupStudioChatTurns(
      [
        { uuid: 'user-1', type: 'user', rewritable: true, content: [{ type: 'text', text: '检查进度' }] },
        { uuid: 'asst-read', type: 'assistant', content: [{ type: 'tool_use', name: 'mcp__arcreel__get_workflow_status' }] },
      ],
      null,
      true,
    );
    expect(runningOnlyPlumbing).toHaveLength(2);
    expect(runningOnlyPlumbing[1]).toMatchObject({
      kind: 'assistant',
      actionSteps: [],
      plumbingHint: '检查制作阶段',
      isActivelyWorking: true,
    });
  });

  it('formats task types into concise Chinese labels', () => {
    expect(formatStudioTaskType('reference_video')).toBe('参考视频');
    expect(formatStudioTaskType('storyboard')).toBe('分镜图');
    expect(formatStudioTaskType('character')).toBe('角色图');
    expect(formatStudioTaskType('timeline_render')).toBe('成片导出');
  });
});
