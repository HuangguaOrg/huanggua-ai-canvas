import type { StudioEntry, StudioExecution } from '../../types/studio';

export interface StudioToolClassification {
  kind: 'hidden' | 'plumbing' | 'action';
  label: string;
}

export interface StudioToolStep {
  key: string;
  label: string;
  count: number;
}

export type StudioAssistantBlock =
  | { type: 'text'; text: string; isError?: boolean; isDraft?: boolean }
  | { type: 'image'; url: string };

export type StudioChatTurn =
  | {
      kind: 'user';
      key: string;
      uuid?: string;
      isQuestionAnswer: boolean;
      rewritable: boolean;
      texts: string[];
      images: string[];
    }
  | {
      kind: 'assistant';
      key: string;
      actionSteps: StudioToolStep[];
      plumbingHint: string | null;
      blocks: StudioAssistantBlock[];
      isActivelyWorking: boolean;
    };

const CUTOFF_RETRY_PREFIX = 'your response above was cut off mid-stream';

const SYNTHETIC_USER_PREFIXES = [
  CUTOFF_RETRY_PREFIX,
  'this session is being continued from a previous conversation',
  'base directory for this skill:',
  'skill content:',
  '[request interrupted',
  '<command-message>',
  '<command-name>',
  '<local-command-stdout>',
  '<local-command-caveat>',
  '<task-notification>',
];

const HIDDEN_TOOLS = new Set([
  'ToolSearch',
  'TodoWrite',
  'TodoRead',
  'EnterPlanMode',
  'ExitPlanMode',
  'AskUserQuestion',
  'Skill',
  'SlashCommand',
]);

const PLUMBING_TOOL_LABELS: Record<string, string> = {
  Read: '读取项目文件',
  Glob: '检索项目目录',
  Grep: '检索脚本内容',
  LS: '浏览项目结构',
  NotebookRead: '读取文档',
  get_project: '读取项目概况',
  get_workflow_status: '检查制作阶段',
  get_generation_batch: '同步生成进度',
  list_tasks: '查询后台任务',
  get_task: '查询任务状态',
  get_script: '读取当前分镜脚本',
  get_source_text: '读取本集故事原文',
  get_script_review: '读取分镜规划稿',
  open_draft: '读取草稿状态',
  get_edit_timeline: '读取剪辑时间线',
  list_edit_timelines: '读取时间线列表',
  list_reference_units: '读取参考视频单元',
  list_asset_versions: '查询资产历史版本',
  list_characters: '读取角色列表',
  list_scenes: '读取场景列表',
  list_props: '读取道具列表',
  list_products: '读取产品列表',
};

const SUBAGENT_LABELS: Record<string, string> = {
  'write-original-story': '创作本集故事原文',
  'normalize-drama-script': '整理标准分集剧本',
  'create-episode-script': '编写分镜与视频提示词',
  'generate-assets': '规划并生成美术资产',
  'ad-storyboard': '编写广告分镜方案',
};

const ACTION_TOOL_LABELS: Record<string, string> = {
  edit_source_text: '保存本集故事正文',
  save_source_text: '保存本集故事正文',
  generate_script_plan: '拆解分镜与剧情规划',
  edit_script_review: '修订分镜规划稿',
  update_script_review: '修订分镜规划稿',
  confirm_script_review: '确认剧本规划',
  generate_episode_script: '编写分镜与视觉提示词',
  generate_ad_script: '生成广告分镜脚本',
  create_blank_script: '初始化空白脚本',
  edit_script: '修改分镜脚本',
  insert_script_item: '新增分镜镜头',
  delete_script_item: '删除分镜镜头',
  create_character: '创建角色',
  update_character: '更新角色设定',
  create_character_derivative: '新增角色衍生形象',
  create_scene: '创建场景',
  update_scene: '更新场景设定',
  create_prop: '创建道具',
  update_prop: '更新道具设定',
  create_product: '创建产品资产',
  update_product: '更新产品资产',
  rename_asset: '重命名资产',
  merge_asset: '合并资产',
  delete_asset: '移除资产',
  generate_assets: '生成美术资产图',
  generate_character_image: '生成角色形象图',
  generate_scene_image: '生成场景概念图',
  generate_prop_image: '生成道具图',
  generate_storyboards: '生成分镜画面',
  generate_storyboard: '生成分镜画面',
  generate_grid: '生成宫格分镜图',
  split_grid: '切分宫格分镜图',
  generate_videos: '提交生成镜头视频',
  generate_video: '提交生成镜头视频',
  generate_reference_videos: '提交生成参考视频',
  generate_reference_video: '提交生成参考视频',
  add_reference_unit: '新增参考视频单元',
  update_reference_unit: '调整参考视频单元',
  delete_reference_unit: '移除参考视频单元',
  parse_reference_units: '拆解参考视频单元',
  select_video_version: '切换采用视频版本',
  restore_version: '恢复历史版本',
  generate_narration_audio: '生成配音与旁白',
  generate_tts: '生成配音与旁白',
  create_edit_timeline: '创建剪辑时间线',
  update_edit_timeline: '编排剪辑时间线',
  edit_timeline: '调整剪辑时间线',
  render_final_cut: '合成导出成片',
  export_timeline: '导出时间线成片',
  Write: '写入项目文件',
  Edit: '编辑项目文件',
  MultiEdit: '批量编辑文件',
  Bash: '执行工作流脚本',
};

const TASK_TYPE_LABELS: Record<string, string> = {
  storyboard: '分镜图',
  storyboards: '分镜图',
  storyboard_image: '分镜图',
  shot_image: '分镜图',
  end_frame: '尾帧图',
  grid: '宫格分镜',
  storyboard_grid: '宫格分镜',
  video: '镜头视频',
  videos: '镜头视频',
  shot_video: '镜头视频',
  reference_video: '参考视频',
  reference_videos: '参考视频',
  character: '角色图',
  characters: '角色图',
  character_image: '角色图',
  character_derivative: '角色衍生图',
  scene: '场景图',
  scenes: '场景图',
  scene_image: '场景图',
  prop: '道具图',
  props: '道具图',
  prop_image: '道具图',
  product: '产品图',
  products: '产品图',
  product_image: '产品图',
  asset: '美术资产',
  assets: '美术资产',
  narration: '旁白配音',
  tts: '旁白配音',
  audio: '音频',
  render: '成片导出',
  timeline_render: '成片导出',
  final_cut: '成片导出',
};

export function isStreamCutoffRetryText(text: string): boolean {
  return text.trim().toLowerCase().startsWith(CUTOFF_RETRY_PREFIX);
}

export function isSyntheticUserMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed.includes('本轮制作要求：')) return false;
  const lowered = trimmed.toLowerCase();
  if (SYNTHETIC_USER_PREFIXES.some(prefix => lowered.startsWith(prefix))) {
    return true;
  }
  const withoutReminder = trimmed.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '').trim();
  return !withoutReminder;
}

export function cleanStudioUserText(text: string): string {
  const afterMarker = text.includes('本轮制作要求：') ? text.split('本轮制作要求：')[1] ?? '' : text;
  const cleaned = afterMarker.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '').trim();
  return cleaned === '请查看附图。' ? '' : cleaned;
}

function appendDetail(baseLabel: string, detail?: string, quoted = false): string {
  const trimmed = detail?.trim();
  if (!trimmed) return baseLabel;
  return quoted ? `${baseLabel}「${trimmed}」` : `${baseLabel}（${trimmed}）`;
}

export function classifyStudioTool(rawName?: string, detail?: string): StudioToolClassification {
  const fullName = (rawName ?? '').trim();
  if (!fullName) return { kind: 'hidden', label: '' };
  const shortName = fullName.replace(/^mcp__arcreel__/i, '');

  if (HIDDEN_TOOLS.has(fullName) || HIDDEN_TOOLS.has(shortName)) {
    return { kind: 'hidden', label: '' };
  }

  const plumbing = PLUMBING_TOOL_LABELS[shortName] ?? PLUMBING_TOOL_LABELS[fullName];
  if (plumbing) {
    return { kind: 'plumbing', label: plumbing };
  }
  if (/^(get_|list_|read_|fetch_|check_|inspect_)/i.test(shortName)) {
    return { kind: 'plumbing', label: '读取项目状态' };
  }

  if (shortName === 'Task' || shortName === 'Agent') {
    const cleanDetail = detail?.trim() ?? '';
    const mappedSubagent = SUBAGENT_LABELS[cleanDetail];
    if (mappedSubagent) return { kind: 'action', label: mappedSubagent };
    if (cleanDetail) return { kind: 'action', label: cleanDetail };
    return { kind: 'action', label: '协同子智能体处理' };
  }

  const knownAction = ACTION_TOOL_LABELS[shortName];
  if (knownAction) {
    const quoted = /^(create_|update_)(character|scene|prop|product)$/.test(shortName);
    return { kind: 'action', label: appendDetail(knownAction, detail, quoted) };
  }

  const humanized = shortName.replace(/_/g, ' ').trim();
  return {
    kind: 'action',
    label: appendDetail(`执行操作 · ${humanized}`, detail),
  };
}

export function formatStudioTaskType(taskType?: string): string {
  const normalized = (taskType ?? '').trim().toLowerCase();
  if (!normalized) return '生成任务';
  return TASK_TYPE_LABELS[normalized] ?? taskType!;
}

export function summarizeActionSteps(steps: StudioToolStep[]): string {
  if (!steps.length) return '';
  const labels = steps.map(step => (step.count > 1 ? `${step.label} ×${step.count}` : step.label));
  if (labels.length <= 2) {
    return labels.join(' → ');
  }
  return `${labels[0]} → ${labels[1]} 等 ${steps.length} 步`;
}

export type StudioAssistantTurn = Extract<StudioChatTurn, { kind: 'assistant' }>;

export function groupStudioChatTurns(
  entries: StudioEntry[],
  draft?: StudioExecution['draft'],
  isRunning = false,
): StudioChatTurn[] {
  const turns: StudioChatTurn[] = [];
  const box: { current: StudioAssistantTurn | null } = { current: null };
  let lastPlumbing: string | null = null;

  const flushAssistant = () => {
    const cur = box.current;
    if (!cur) return;
    if (cur.actionSteps.length > 0 || cur.blocks.length > 0) {
      turns.push(cur);
    }
    box.current = null;
    lastPlumbing = null;
  };

  const ensureAssistant = (seedKey: string): StudioAssistantTurn => {
    if (!box.current) {
      box.current = {
        kind: 'assistant',
        key: seedKey,
        actionSteps: [],
        plumbingHint: null,
        blocks: [],
        isActivelyWorking: false,
      };
    }
    return box.current;
  };

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isUser = entry.role === 'user' || entry.type === 'user';

    if (isUser) {
      const rawTexts = (entry.content ?? [])
        .filter(b => b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text ?? '');
      const combinedRaw = rawTexts.join('\n');

      // Defense-in-depth: hide synthetic stream-cutoff retry prompts & drop truncated draft text right before them.
      if (isStreamCutoffRetryText(combinedRaw)) {
        const hasLaterAssistant = entries.slice(i + 1).some(later => later.role !== 'user' && later.type !== 'user');
        if (hasLaterAssistant && box.current) {
          box.current.blocks = box.current.blocks.filter(b => b.type !== 'text' || b.isError);
          if (!box.current.actionSteps.length && !box.current.blocks.length) {
            box.current = null;
          }
        }
        continue;
      }

      const images = (entry.content ?? [])
        .filter(b => b.type === 'image' && typeof b.url === 'string' && b.url.length > 0)
        .map(b => b.url!);

      const isQA = entry.subtype === 'question_answer';
      const cleanedTexts = isQA
        ? rawTexts.map(t => t.trim()).filter(Boolean)
        : rawTexts
            .filter(t => !isSyntheticUserMessage(t))
            .map(cleanStudioUserText)
            .filter(Boolean);

      if (!cleanedTexts.length && !images.length) {
        continue;
      }

      flushAssistant();
      const canRewrite =
        !isQA &&
        Boolean(entry.uuid) &&
        (entry.rewritable ?? (entry.uuid!.startsWith('user-') || combinedRaw.includes('本轮制作要求：')));

      turns.push({
        kind: 'user',
        key: entry.uuid ?? `user-${i}`,
        uuid: entry.uuid,
        isQuestionAnswer: isQA,
        rewritable: canRewrite,
        texts: cleanedTexts,
        images,
      });
      continue;
    }

    const assistantTurn = ensureAssistant(entry.uuid ?? `assistant-${i}`);
    const isErrorEntry = entry.subtype === 'error';

    for (const block of entry.content ?? []) {
      if (block.type === 'tool_use') {
        const classified = classifyStudioTool(block.name, block.detail);
        if (classified.kind === 'hidden') continue;
        if (classified.kind === 'plumbing') {
          lastPlumbing = classified.label;
          continue;
        }
        const prevStep = assistantTurn.actionSteps.at(-1);
        if (prevStep && prevStep.label === classified.label) {
          prevStep.count += 1;
        } else {
          assistantTurn.actionSteps.push({
            key: `${assistantTurn.actionSteps.length}-${classified.label}`,
            label: classified.label,
            count: 1,
          });
        }
      } else if (block.type === 'image' && block.url) {
        assistantTurn.blocks.push({ type: 'image', url: block.url });
      } else if (block.type === 'text' && block.text?.trim()) {
        assistantTurn.blocks.push({
          type: 'text',
          text: block.text.trim(),
          isError: Boolean(block.is_error || isErrorEntry),
        });
      }
    }
  }

  // Attach live streaming draft blocks directly into the active assistant turn.
  const draftTexts = (draft?.content ?? [])
    .filter(b => b.type === 'text' && b.text?.trim())
    .map(b => b.text!.trim());

  if (draftTexts.length > 0) {
    const activeTurn = ensureAssistant('assistant-live-draft');
    for (const text of draftTexts) {
      activeTurn.blocks.push({ type: 'text', text, isDraft: true });
    }
  }

  if (isRunning) {
    const cur = box.current;
    if (cur) {
      cur.isActivelyWorking = true;
      if (!cur.actionSteps.length && !cur.blocks.length && lastPlumbing) {
        cur.plumbingHint = lastPlumbing;
      }
      turns.push(cur);
      box.current = null;
    } else if (turns.at(-1)?.kind === 'user') {
      turns.push({
        kind: 'assistant',
        key: 'assistant-working',
        actionSteps: [],
        plumbingHint: lastPlumbing,
        blocks: [],
        isActivelyWorking: true,
      });
    }
  } else {
    flushAssistant();
  }

  return turns;
}
