import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ImagePlus,
  Loader2,
  PanelRightClose,
  RefreshCw,
  RotateCcw,
  Send,
  SlidersHorizontal,
  Sparkles,
  Square,
} from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { useT } from '../../i18n';
import type { StudioAttachment, StudioEpisode, StudioProject, StudioQuestion } from '../../types/studio';
import Select from '../shared/Select';
import HuangguaModelRefreshButton from '../account/HuangguaModelRefreshButton';
import StudioVideoModelPicker from './StudioVideoModelPicker';
import { selectStudioModel } from '../../services/studioModelSelection';
import StudioSessions, { StudioSessionHeaderActions } from './StudioSessions';
import StudioAttachments, { type AttachmentHandle } from './StudioAttachments';
import StudioMessageQueue from './StudioMessageQueue';
import { studioWorkspace, workspaceError } from '../../services/studioWorkspaceService';
import { useWorkspaceQuery } from './useWorkspaceQuery';
import { hasProjectStyleConfigured } from './styleTemplates';
import {
  formatStudioTaskType,
  groupStudioChatTurns,
  summarizeActionSteps,
  type StudioToolStep,
} from './studioChatFormatter';

const TASK_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const QUICK_PROMPTS = [
  '拆解本集分镜脚本与剧情规划',
  '提取并生成本集角色与场景资产图',
  '按当前分镜脚本提交生成视频',
];

export default function StudioAgentPanel({
  project,
  episode,
  isOpen,
  onClose,
}: {
  project: StudioProject;
  episode: StudioEpisode;
  isOpen: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const state = useAppStore(
    useShallow(s => ({
      connection: s.studioConnection,
      error: s.studioConnectionError,
      models: s.studioModels,
      videoModels: s.studioVideoModelsByMode,
      videoSpecs: s.studioVideoSpecs,
      refreshModels: s.refreshStudioModels,
      historyLimit: s.studioHistoryLimits[`${project.id}/${episode.id}`] ?? 100,
      execution: s.studioExecutions[`${project.id}/${episode.id}`],
      submitting: s.studioSubmitting[`${project.id}/${episode.id}`],
      connect: s.connectStudio,
      run: s.runStudio,
      control: s.controlStudio,
      edit: s.editStudioEpisode,
    })),
  );

  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [rewriteBusy, setRewriteBusy] = useState(false);
  const [rewriteError, setRewriteError] = useState('');

  const scope = { projectId: project.id, episodeId: episode.id };
  const projectQuery = useWorkspaceQuery<{
    project?: { style_template_id?: string | null; style_image?: string | null; style?: string | null } | null;
  }>(scope, 'project', undefined, isOpen);
  const styleMissing =
    projectQuery.data !== undefined && !hasProjectStyleConfigured(projectQuery.data.project, project.styleTemplateId);

  const attachmentInput = useRef<AttachmentHandle>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const flow = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 58), 168)}px`;
  }, [episode.agentBrief]);

  const beginRewrite = async (id: string) => {
    const hasDraft = () => {
      const current = useAppStore
        .getState()
        .studioDraft.projects.find(p => p.id === project.id)
        ?.episodes.find(e => e.id === episode.id);
      return !!current && (!!current.agentBrief.trim() || !!current.attachments?.length);
    };
    if (hasDraft()) {
      setRewriteError('输入框中有未发送草稿，请先发送或清空后再改写历史消息。');
      return;
    }
    setRewriteBusy(true);
    setRewriteError('');
    try {
      const result = await studioWorkspace<{ text: string; attachments: StudioAttachment[] }>(
        scope,
        'message_attachments',
        { id },
      );
      const store = useAppStore.getState();
      if (store.studioDraft.projectId !== project.id || store.studioDraft.episodeId !== episode.id) return;
      if (hasDraft()) {
        setRewriteError('已保留你正在编辑的草稿，请先发送或清空后再改写。');
        return;
      }
      store.editStudioEpisode(episode.id, { agentBrief: result.text, rewriteAnchor: id });
      store.setStudioAttachments(project.id, episode.id, result.attachments);
      textareaRef.current?.focus();
    } catch (e) {
      setRewriteError(workspaceError(e));
    } finally {
      setRewriteBusy(false);
    }
  };

  const available = {
    video: state.videoModels[project.generationMode ?? 'storyboard'] ?? [],
    image: state.models.image ?? [],
    text: state.models.text ?? [],
  };
  const selected: Record<string, string> = {};
  for (const [kind, ids] of Object.entries(available)) {
    const id = selectStudioModel(episode.models?.[kind], ids);
    if (id) selected[kind] = id;
  }
  const running = state.execution?.status === 'running' || Boolean(state.submitting);
  const tasks = state.execution?.tasks ?? [];
  const activeTasks = tasks.filter(task => ['queued', 'running'].includes(task.status));
  const succeededTasksCount = tasks.filter(task => task.status === 'succeeded').length;
  const entries = useMemo(() => state.execution?.entries ?? [], [state.execution?.entries]);
  const turns = useMemo(
    () => groupStudioChatTurns(entries, state.execution?.draft, running),
    [entries, state.execution?.draft, running],
  );

  const latestKey = JSON.stringify([turns.length, turns.at(-1), running]);
  useLayoutEffect(() => {
    if (isOpen && flow.current && following.current) {
      flow.current.scrollTop = flow.current.scrollHeight;
    }
  }, [latestKey, isOpen]);

  const attachments = episode.attachments ?? [];
  const cannotSend =
    state.connection !== 'ready' ||
    styleMissing ||
    Boolean(state.execution?.supersededBy) ||
    Boolean(state.submitting) ||
    attachmentBusy ||
    rewriteBusy ||
    Boolean(episode.submission) ||
    attachments.length > 5 ||
    (!episode.agentBrief.trim() && !attachments.length);

  const statusText = running
    ? '执行中'
    : state.connection === 'ready'
      ? '已就绪'
      : state.connection === 'connecting'
        ? '连接中'
        : '未连接';
  const statusDotClass = running
    ? 'is-running animate-pulse'
    : state.error || state.execution?.error
      ? 'is-error'
      : state.connection === 'ready'
        ? 'is-ready'
        : '';

  const rewriteDisabled =
    rewriteBusy ||
    attachmentBusy ||
    Boolean(state.execution?.supersededBy) ||
    running ||
    Boolean(episode.submission) ||
    Boolean(state.execution?.queued?.length) ||
    Boolean(state.execution?.questions.length);

  return (
    <aside className="studio-agent flex min-h-0 flex-col bg-canvas-surface" aria-label={t('短剧 Agent')}>
      <header className="flex h-11 shrink-0 items-center gap-1.5 border-b border-canvas-border px-2.5">
        <button
          type="button"
          className="ui-btn ui-btn--ghost ui-btn--sm px-1.5"
          title={t('收起 Agent')}
          aria-label={t('收起 Agent')}
          onClick={onClose}
        >
          <PanelRightClose size={15} />
        </button>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold" title={`${project.name} · ${episode.name}`}>
          {episode.name} · Agent
        </span>
        <span role="status" className="inline-flex items-center gap-1.5 px-1 text-[11px] text-canvas-text-muted">
          <span className={`studio-status-dot ${statusDotClass}`} />
          {t(statusText)}
        </span>
        {(state.connection !== 'ready' || state.error || state.execution?.error) && (
          <button
            type="button"
            className="ui-btn ui-btn--ghost ui-btn--sm px-1.5"
            title={t('重新连接执行服务')}
            aria-label={t('连接执行服务')}
            disabled={state.connection === 'connecting'}
            onClick={() => void state.connect()}
          >
            <RefreshCw size={13} className={state.connection === 'connecting' ? 'animate-spin' : ''} />
          </button>
        )}
        <StudioSessionHeaderActions
          scope={scope}
          disabled={running || Boolean(episode.submission)}
          open={sessionsOpen}
          onToggle={() => setSessionsOpen(v => !v)}
        />
      </header>

      <StudioSessions scope={scope} disabled={running || Boolean(episode.submission)} open={sessionsOpen} />

      <div
        ref={flow}
        className="ui-scroll min-h-0 flex-1 space-y-3.5 overflow-y-auto px-3.5 py-3"
        aria-label={t('Agent 对话')}
        onScroll={() => {
          const el = flow.current;
          if (isOpen && el) {
            following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }
        }}
      >
        {!turns.length && (
          <div className="flex min-h-56 flex-col items-center justify-center gap-3 px-2 py-6 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-canvas-border bg-canvas-card text-[var(--brand-light)]">
              <Bot size={20} />
            </div>
            <div className="space-y-1">
              <h2 className="text-xs font-semibold">{t('一起完成这一集')}</h2>
              <p className="max-w-[260px] text-[11px] leading-5 text-canvas-text-muted">
                {t('直接描述想法或修改意见，Agent 会自动衔接当前分集剧本、资产与视频任务。')}
              </p>
            </div>
            <div className="mt-1 flex flex-wrap justify-center gap-1.5">
              {QUICK_PROMPTS.map(prompt => (
                <button
                  key={prompt}
                  type="button"
                  className="ui-btn ui-btn--sm text-[11px]"
                  onClick={() => {
                    state.edit(episode.id, { agentBrief: prompt });
                    textareaRef.current?.focus();
                  }}
                >
                  <Sparkles size={11} className="text-[var(--brand-light)]" />
                  <span>{prompt}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {state.execution?.hasOlder &&
          (state.historyLimit < 1000 ? (
            <div className="flex justify-center">
              <button
                type="button"
                className="ui-btn ui-btn--ghost ui-btn--sm text-[11px]"
                onClick={() => {
                  following.current = false;
                  useAppStore.getState().loadMoreStudioHistory(`${project.id}/${episode.id}`);
                }}
              >
                加载更早对话
              </button>
            </div>
          ) : (
            <p className="text-center text-[11px] text-canvas-text-muted">
              已显示最近 1000 条对话，更早记录仍保存在本机。
            </p>
          ))}

        {turns.map(turn => {
          if (turn.kind === 'user') {
            if (turn.isQuestionAnswer) {
              return (
                <div key={turn.key} className="flex justify-end">
                  <div className="studio-qa-chip inline-flex items-center gap-1.5 text-[11px]">
                    <Check size={11} className="shrink-0 text-[var(--success-text)]" />
                    <span className="truncate">{turn.texts.join(' · ')}</span>
                  </div>
                </div>
              );
            }
            return (
              <article key={turn.key} className="group flex flex-col items-end gap-1">
                <div className="studio-user-bubble space-y-2 text-xs leading-6">
                  {turn.images.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {turn.images.map((url, idx) => (
                        <img key={idx} src={url} alt="对话附图" className="max-h-36 rounded-lg object-cover" />
                      ))}
                    </div>
                  )}
                  {turn.texts.map((txt, idx) => (
                    <p key={idx} className="whitespace-pre-wrap break-words">
                      {txt}
                    </p>
                  ))}
                </div>
                {turn.rewritable && turn.uuid && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-canvas-text-muted opacity-70 transition-opacity hover:bg-canvas-hover hover:text-canvas-text focus:opacity-100 disabled:pointer-events-none disabled:opacity-30 sm:opacity-0 sm:group-hover:opacity-100"
                    disabled={rewriteDisabled}
                    onClick={() => void beginRewrite(turn.uuid!)}
                  >
                    <RotateCcw size={10} />
                    <span>从此处改写</span>
                  </button>
                )}
              </article>
            );
          }

          const showStandaloneThinking =
            turn.isActivelyWorking &&
            turn.actionSteps.length === 0 &&
            !turn.blocks.some(b => b.type === 'text' && b.isDraft);

          return (
            <article key={turn.key} className="space-y-2 pr-1 text-xs">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-canvas-text-muted">
                <Bot size={12} className="text-[var(--brand-light)]" />
                <span>{t('黄瓜 AI')}</span>
              </div>

              {turn.actionSteps.length > 0 && (
                <AssistantStepGroup
                  steps={turn.actionSteps}
                  active={turn.isActivelyWorking && turn.blocks.length === 0}
                />
              )}

              {turn.blocks.map((block, idx) => {
                if (block.type === 'image') {
                  return <img key={idx} src={block.url} alt="生成预览" className="max-h-44 rounded-lg" />;
                }
                if (block.isError) {
                  return (
                    <p key={idx} role="alert" className="ui-alert text-xs leading-5">
                      {block.text}
                    </p>
                  );
                }
                return <FormattedMarkdown key={idx} text={block.text} />;
              })}

              {showStandaloneThinking && (
                <div className="studio-step-pill">
                  <Loader2 size={11} className="shrink-0 animate-spin text-[var(--brand-light)]" />
                  <span>{turn.plumbingHint ? `正在${turn.plumbingHint}…` : '正在分析与规划…'}</span>
                </div>
              )}
            </article>
          );
        })}
      </div>

      {tasks.length > 0 && (
        <details className="shrink-0 border-t border-canvas-border text-xs">
          <summary className="flex cursor-pointer select-none items-center gap-2 px-3.5 py-2 text-[11px] text-canvas-text-secondary hover:bg-canvas-hover/50">
            <ChevronDown size={12} className="shrink-0" />
            <span className="font-medium">{t('制作任务')}</span>
            <span className="ml-auto inline-flex items-center gap-1.5 text-canvas-text-muted">
              {activeTasks.length > 0 ? (
                <>
                  <Loader2 size={11} className="animate-spin text-[var(--brand-light)]" />
                  <span>
                    {activeTasks.length} {t('执行中')}
                  </span>
                </>
              ) : (
                <span>
                  {succeededTasksCount}/{tasks.length} {t('已完成')}
                </span>
              )}
            </span>
          </summary>
          <div className="ui-scroll max-h-36 space-y-1.5 overflow-y-auto px-3.5 pb-2.5">
            {tasks.map(task => (
              <div
                className="flex items-center gap-2 rounded-md border border-canvas-border bg-canvas-card/40 px-2.5 py-1.5 text-[11px]"
                key={task.task_id}
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium text-canvas-text">{formatStudioTaskType(task.task_type)}</span>
                  {task.resource_id ? <span className="text-canvas-text-muted"> · {task.resource_id}</span> : null}
                </span>
                {typeof task.progress === 'number' && task.status === 'running' && task.progress > 0 && task.progress < 100 && (
                  <span className="tabular-nums text-canvas-text-muted">{Math.round(task.progress)}%</span>
                )}
                <span
                  className={
                    task.status === 'succeeded'
                      ? 'text-[var(--success-text)]'
                      : task.status === 'failed'
                        ? 'text-[var(--danger-light)]'
                        : 'text-canvas-text-muted'
                  }
                >
                  {t(TASK_STATUS_LABELS[task.status] ?? task.status)}
                </span>
                {task.status === 'queued' && (
                  <button
                    type="button"
                    className="ui-btn ui-btn--ghost ui-btn--sm px-1.5 text-[10px]"
                    onClick={() => void state.control('cancel_task', { taskId: task.task_id })}
                  >
                    {t('取消')}
                  </button>
                )}
              </div>
            ))}
          </div>
        </details>
      )}

      {state.connection === 'connecting' && (
        <p role="status" className="mx-3 my-1.5 text-[11px] text-canvas-text-muted">
          {t('正在准备本地短剧运行环境，首次启动可能需要一两分钟…')}
        </p>
      )}
      {(state.error || state.execution?.error) && (
        <p role="alert" className="ui-alert mx-3 my-1.5 text-xs">
          {workspaceError(state.error || state.execution?.error)}
        </p>
      )}

      {!!state.execution?.questions.length && (
        <div className="ui-scroll max-h-56 shrink-0 space-y-2 overflow-y-auto border-t border-canvas-border p-3">
          {state.execution.questions.map(question => (
            <Question
              key={question.question_id}
              value={question}
              onAnswer={answers => state.control('answer', { questionId: question.question_id, answers })}
            />
          ))}
        </div>
      )}

      {!!state.execution?.queued?.length && (
        <StudioMessageQueue
          scope={scope}
          messages={state.execution.queued}
          disabled={Boolean(state.submitting)}
          questionPending={Boolean(state.execution.questions.length)}
        />
      )}

      {episode.submission && !state.submitting && (
        <div className="flex items-center justify-between gap-2 border-t border-canvas-border bg-canvas-card/40 px-3 py-2 text-xs">
          <span className="text-canvas-text-secondary">{t('上次提交结果待确认，可原样恢复请求。')}</span>
          <button type="button" className="ui-btn ui-btn--primary ui-btn--sm shrink-0" onClick={() => void state.run(selected, true)}>
            {t('恢复提交')}
          </button>
        </div>
      )}

      <div className="shrink-0 border-t border-canvas-border p-2.5">
        {activeTasks.length > 0 && !running && (
          <p role="status" className="mb-1.5 text-[11px] leading-5 text-canvas-text-muted">
            {t('后台生成任务进行中，完成后将自动同步到分镜与资源库。')}
          </p>
        )}

        {styleMissing && (
          <div
            role="alert"
            className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs"
          >
            <span className="leading-5">开始前请先选定画面风格模版或上传参考图。</span>
            <button
              type="button"
              className="ui-btn ui-btn--primary ui-btn--sm shrink-0"
              onClick={() => window.dispatchEvent(new Event('studio-navigate-style'))}
            >
              选择风格
            </button>
          </div>
        )}

        {rewriteError && (
          <p role="alert" className="ui-alert mb-2 text-xs">
            {rewriteError}
          </p>
        )}

        {state.execution?.supersededBy && (
          <p className="ui-alert mb-2 text-xs">当前查看的是改写前历史分支，请在右上角「会话历史」切回最新会话。</p>
        )}

        {episode.rewriteAnchor && (
          <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-[var(--brand-alpha-25)] bg-[var(--brand-alpha-10)] px-2.5 py-1.5 text-[11px]">
            <span>发送后将从所选消息创建新对话分支，原记录保留。</span>
            <button
              type="button"
              className="ui-btn ui-btn--ghost ui-btn--sm shrink-0"
              onClick={() => state.edit(episode.id, { rewriteAnchor: undefined })}
            >
              取消改写
            </button>
          </div>
        )}

        <div
          className="ui-ai-input p-2.5"
          onDragOver={e => e.preventDefault()}
          onDrop={e => {
            e.preventDefault();
            void attachmentInput.current?.add(Array.from(e.dataTransfer.files));
          }}
        >
          <StudioAttachments
            ref={attachmentInput}
            scope={scope}
            attachments={attachments}
            disabled={Boolean(episode.submission)}
            onBusy={setAttachmentBusy}
          />

          <label className="sr-only" htmlFor="studio-brief">
            {t('制作要求')}
          </label>
          <textarea
            ref={textareaRef}
            id="studio-brief"
            rows={2}
            maxLength={20000}
            value={episode.agentBrief}
            onPaste={e => {
              const files = Array.from(e.clipboardData.files);
              if (files.length) {
                e.preventDefault();
                void attachmentInput.current?.add(files);
              }
            }}
            onKeyDown={event => {
              if (
                (event.ctrlKey || event.metaKey) &&
                event.key === 'Enter' &&
                !event.nativeEvent.isComposing &&
                !cannotSend
              ) {
                event.preventDefault();
                following.current = true;
                void state.run(selected);
              }
            }}
            onChange={e => state.edit(episode.id, { agentBrief: e.target.value })}
            className="ui-input studio-agent-textarea w-full text-xs leading-5"
            placeholder={t('输入制作要求，如：先拆解本集分镜脚本（支持粘贴或拖入图片/视频）')}
          />

          <div className="mt-1.5 flex items-center justify-between gap-1.5">
            <div className="flex min-w-0 items-center gap-1">
              <button
                type="button"
                className="ui-btn ui-btn--ghost ui-btn--sm shrink-0 px-2"
                title="添加本地参考图片或视频（最多 5 个，支持粘贴或拖入）"
                aria-label={t('上传本地图片或视频')}
                disabled={Boolean(episode.submission) || attachmentBusy || attachments.length >= 5}
                onClick={() => attachmentInput.current?.openPicker()}
              >
                <ImagePlus size={13} />
                {attachments.length > 0 && <span className="text-[10px] tabular-nums">{attachments.length}/5</span>}
              </button>

              <button
                type="button"
                className={`ui-btn ui-btn--ghost ui-btn--sm min-w-0 px-2 ${modelsOpen ? 'is-active' : ''}`}
                aria-expanded={modelsOpen}
                aria-label={t('模型设置')}
                aria-controls="studio-model-options"
                onClick={() => setModelsOpen(!modelsOpen)}
              >
                <SlidersHorizontal size={12} className="shrink-0" />
                <span className="max-w-32 truncate text-[11px]">{state.videoSpecs[selected.video]?.display_name || selected.video || selected.text || t('模型设置')}</span>
                <ChevronDown size={11} className="shrink-0" />
              </button>
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              {running && (
                <button
                  type="button"
                  className="ui-btn ui-btn--sm"
                  onClick={() => void state.control('interrupt')}
                >
                  <Square size={11} />
                  <span>{t('停止')}</span>
                </button>
              )}
              <button
                type="button"
                className="ui-btn ui-btn--primary ui-btn--sm"
                disabled={cannotSend}
                onClick={() => {
                  following.current = true;
                  void state.run(selected);
                }}
              >
                <Send size={12} />
                <span>{t(episode.rewriteAnchor ? '改写并发送' : running ? '加入队列' : '发送')}</span>
              </button>
            </div>
          </div>
        </div>

        {modelsOpen && (
          <div
            id="studio-model-options"
            className="ui-scroll mt-2 max-h-[min(50vh,24rem)] space-y-2 overflow-y-auto rounded-lg border border-canvas-border bg-canvas-card/40 p-2.5"
          >
            <HuangguaModelRefreshButton />
            <StudioVideoModelPicker key={episode.id + '/' + (project.generationMode ?? 'storyboard')} scope={{ projectId: project.id, episodeId: episode.id }}
                ids={available.video} specs={state.videoSpecs} value={selected.video ?? ''} lock={episode.nativeVideoResolution}
                disabled={running} refreshModels={state.refreshModels}
                onChange={(id, lock) => state.edit(episode.id, { models: { video: id }, nativeVideoResolution: lock })} />
            {(['image', 'text'] as const).map(kind => (
              <label key={kind} className="block text-[11px] text-canvas-text-muted">
                {t(kind === 'text' ? '文本模型' : '图片模型')}
                <Select
                  className="mt-1 w-full"
                  aria-label={t(kind === 'text' ? '文本模型' : '图片模型')}
                  placeholder={t('暂无可用模型')}
                  disabled={running || !available[kind].length}
                  value={selected[kind] ?? ''}
                  options={available[kind].map(value => ({ value, label: value }))}
                  onChange={value => state.edit(episode.id, { models: { [kind]: value } })}
                />
              </label>
            ))}
          </div>
        )}

        <p className="mt-1.5 px-0.5 text-[10px] text-canvas-text-muted">
          {t('Ctrl+Enter 快捷发送 · 调用模型按量计费，生成资源自动保存至本地与资源库')}
        </p>
      </div>
    </aside>
  );
}

function AssistantStepGroup({ steps, active }: { steps: StudioToolStep[]; active: boolean }) {
  const [expanded, setExpanded] = useState(false);

  if (steps.length === 1) {
    const only = steps[0];
    return (
      <div className="studio-step-pill">
        {active ? (
          <Loader2 size={11} className="shrink-0 animate-spin text-[var(--brand-light)]" />
        ) : (
          <Check size={11} className="shrink-0 text-[var(--success-text)]" />
        )}
        <span className="truncate">
          {only.label}
          {only.count > 1 ? ` ×${only.count}` : ''}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        className="studio-step-pill text-left"
        aria-expanded={expanded}
        onClick={() => setExpanded(v => !v)}
      >
        {active ? (
          <Loader2 size={11} className="shrink-0 animate-spin text-[var(--brand-light)]" />
        ) : (
          <Check size={11} className="shrink-0 text-[var(--success-text)]" />
        )}
        <span className="min-w-0 flex-1 truncate">
          {active ? `正在执行 · ${steps.at(-1)?.label}` : `已完成 ${steps.length} 步 · ${summarizeActionSteps(steps)}`}
        </span>
        {expanded ? <ChevronDown size={11} className="shrink-0" /> : <ChevronRight size={11} className="shrink-0" />}
      </button>
      {expanded && (
        <ol className="space-y-1 rounded-lg border border-canvas-border bg-canvas-card/40 px-3 py-2 text-[11px] text-canvas-text-secondary">
          {steps.map((step, i) => {
            const isCurrent = active && i === steps.length - 1;
            return (
              <li key={step.key} className="flex items-center gap-2">
                <span className="w-4 shrink-0 tabular-nums text-canvas-text-muted">{i + 1}.</span>
                <span className={`min-w-0 flex-1 truncate ${isCurrent ? 'font-medium text-canvas-text' : ''}`}>
                  {step.label}
                  {step.count > 1 ? ` ×${step.count}` : ''}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function renderInlineMarkdown(line: string): ReactNode[] {
  const tokens = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return tokens.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={idx} className="font-semibold text-canvas-text">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={idx}>{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

function FormattedMarkdown({ text }: { text: string }) {
  const lines = text.split('\n');
  const elements: ReactNode[] = [];
  let listItems: Array<{ ordered: boolean; content: string }> = [];
  let codeFence: string[] | null = null;

  const flushList = (keySeed: number) => {
    if (!listItems.length) return;
    const isOrdered = listItems[0].ordered;
    const Tag = isOrdered ? 'ol' : 'ul';
    elements.push(
      <Tag
        key={`list-${keySeed}`}
        className={`space-y-1 pl-4 ${isOrdered ? 'list-decimal' : 'list-disc'} text-canvas-text`}
      >
        {listItems.map((item, idx) => (
          <li key={idx} className="leading-6">
            {renderInlineMarkdown(item.content)}
          </li>
        ))}
      </Tag>,
    );
    listItems = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    if (trimmed.startsWith('```')) {
      flushList(i);
      if (codeFence === null) {
        codeFence = [];
      } else {
        elements.push(
          <pre
            key={`code-${i}`}
            className="ui-scroll overflow-x-auto rounded-lg border border-canvas-border bg-canvas-card p-2.5 text-[11px] leading-5"
          >
            {codeFence.join('\n')}
          </pre>,
        );
        codeFence = null;
      }
      continue;
    }

    if (codeFence !== null) {
      codeFence.push(rawLine);
      continue;
    }

    if (!trimmed) {
      flushList(i);
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      flushList(i);
      elements.push(<hr key={`hr-${i}`} className="border-canvas-border/60" />);
      continue;
    }

    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      flushList(i);
      elements.push(
        <h3 key={`h-${i}`} className="pt-1 text-xs font-semibold text-canvas-text">
          {renderInlineMarkdown(headingMatch[2])}
        </h3>,
      );
      continue;
    }

    const bulletMatch = /^[-*•]\s+(.+)$/.exec(trimmed);
    if (bulletMatch) {
      if (listItems.length && listItems[0].ordered) flushList(i);
      listItems.push({ ordered: false, content: bulletMatch[1] });
      continue;
    }

    const orderedMatch = /^\d+[.)、]\s+(.+)$/.exec(trimmed);
    if (orderedMatch) {
      if (listItems.length && !listItems[0].ordered) flushList(i);
      listItems.push({ ordered: true, content: orderedMatch[1] });
      continue;
    }

    flushList(i);
    elements.push(
      <p key={`p-${i}`} className="whitespace-pre-wrap break-words leading-6 text-canvas-text">
        {renderInlineMarkdown(rawLine)}
      </p>,
    );
  }

  flushList(lines.length);
  if (codeFence !== null && codeFence.length > 0) {
    elements.push(
      <pre
        key="code-tail"
        className="ui-scroll overflow-x-auto rounded-lg border border-canvas-border bg-canvas-card p-2.5 text-[11px] leading-5"
      >
        {codeFence.join('\n')}
      </pre>,
    );
  }

  return <div className="studio-md space-y-2">{elements}</div>;
}

function Question({
  value,
  onAnswer,
}: {
  value: StudioQuestion;
  onAnswer: (answers: Record<string, string>) => Promise<void>;
}) {
  const t = useT();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="space-y-2.5 rounded-lg border border-[var(--brand-alpha-25)] bg-[var(--brand-alpha-08)] p-3"
      onSubmit={e => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        void onAnswer(answers).finally(() => setBusy(false));
      }}
    >
      {value.questions.map(q => (
        <fieldset className="space-y-2 text-xs" key={q.question}>
          <legend className="font-medium leading-5 text-canvas-text">{q.question}</legend>
          {!!q.options?.length && (
            <div className="flex flex-wrap gap-1.5">
              {q.options.map(option => {
                const chosen = (answers[q.question] ?? '').split(', ').filter(Boolean).includes(option.label);
                return (
                  <button
                    key={option.label}
                    type="button"
                    aria-pressed={chosen}
                    title={option.description}
                    className={`ui-btn ui-btn--sm ${chosen ? 'ui-btn--primary' : ''}`}
                    onClick={() =>
                      setAnswers(previous => {
                        const selected = (previous[q.question] ?? '').split(', ').filter(Boolean);
                        return {
                          ...previous,
                          [q.question]: q.multiSelect
                            ? (selected.includes(option.label)
                                ? selected.filter(x => x !== option.label)
                                : [...selected, option.label]
                              ).join(', ')
                            : option.label,
                        };
                      })
                    }
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          )}
          <input
            aria-label={q.question}
            required
            className="ui-input w-full text-xs"
            placeholder={t('选择上方选项，或直接输入补充说明…')}
            value={answers[q.question] ?? ''}
            onChange={e => setAnswers(s => ({ ...s, [q.question]: e.target.value }))}
          />
        </fieldset>
      ))}
      <div className="flex justify-end">
        <button className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy} type="submit">
          {t('确认并继续')}
        </button>
      </div>
    </form>
  );
}
