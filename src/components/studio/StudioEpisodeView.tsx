import { useState, useEffect, useRef, useMemo } from 'react';
import { ArrowLeft, ArrowRight, FileText, Film, Image, Layers3, PanelLeftClose, PanelLeftOpen, Plus } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { useT } from '../../i18n';
import type { StudioArtifact, StudioEpisode, StudioProject } from '../../types/studio';
import Tabs from '../shared/Tabs';
import { useStudioScript, type StudioDisplayShot } from './useStudioScript';
import StudioTimeline from './StudioTimeline';
import StudioScriptEditor from './StudioScriptEditor';
import StudioPlanning from './StudioPlanning';
import StudioProductionSetup from './StudioProductionSetup';
import StudioReferenceVideo from './StudioReferenceVideo';
import { studioWorkspace, workspaceError } from '../../services/studioWorkspaceService';
import { pollStudioExecutions } from '../../services/studioExecutionService';
import { StudioArtifactGrid } from './StudioResults';
import StudioShotGenerate from './StudioShotGenerate';
import StudioUpload from './StudioUpload';
import StudioVersions from './StudioVersions';

const noArtifacts: StudioArtifact[] = [];
export default function StudioEpisodeView({ project, episode, onAsk }: { project: StudioProject; episode: StudioEpisode; onAsk: () => void }) {
  const t = useT();
  const stage = useAppStore(s => s.studioStage);
  const setStage = useAppStore(s => s.setStudioStage);
  const edit = useAppStore(s => s.editStudioEpisode);
  const execution = useAppStore(s => s.studioExecutions[`${project.id}/${episode.id}`]);
  const formal = useStudioScript(execution?.artifacts ?? noArtifacts);
  const registeredSource = (execution?.artifacts ?? noArtifacts).filter(a => a.name === `source/episode_${execution?.episodeNumber}.txt`);
  const shots: StudioDisplayShot[] = useMemo(() => formal.formal ? formal.shots ?? [] : episode.shots, [formal.formal, formal.shots, episode.shots]);
  const [selected, setSelected] = useState<string | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [listCollapsed, setListCollapsed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [operationError, setOperationError] = useState('');
  const shot = shots.find(s => s.id === selected) ?? shots[0];
  const index = shot ? shots.indexOf(shot) : -1;
  const view = stage === 'shots' || stage === 'video' ? 'board' : stage === 'delivery' ? 'edit' : 'plan';
  const tasks = execution?.tasks ?? [];
  const active = tasks.filter(task => ['queued', 'running'].includes(task.status));
  const completed = tasks.filter(task => task.status === 'succeeded').length;
  const root = useRef<HTMLDivElement>(null);
  const scope = { projectId: project.id, episodeId: episode.id };
  useEffect(() => {
    const navigate = (event: KeyboardEvent) => {
      if (view !== 'board' || event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      const target = event.target as HTMLElement;
      if (target !== document.body && !root.current?.contains(target)) return;
      if (target.closest('input,textarea,select,[contenteditable="true"],[role="dialog"]')) return;
      const next = event.key.toLowerCase() === 'j' ? shots[index + 1] : event.key.toLowerCase() === 'k' ? shots[index - 1] : null;
      if (next) { event.preventDefault(); setSelected(next.id); }
    };
    document.addEventListener('keydown', navigate); return () => document.removeEventListener('keydown', navigate);
  }, [view, shots, index]);
  const patchShot = (patch: Partial<StudioDisplayShot>) => {
    if (shot && !formal.formal) edit(episode.id, { shots: episode.shots.map(s => s.id === shot.id ? { ...s, ...patch } : s) });
  };
  const ensureFormalShot = async () => {
    if (formal.formal && shot) return { name: shot.id };
    const result = await studioWorkspace<{ shotId: string }>(scope, 'ensure_formal_shot', {
      data: { index: Math.max(index, 0), shots: episode.shots },
    });
    setSelected(result.shotId);
    return { name: result.shotId };
  };
  const clearEndFrame = async () => {
    if (!shot || !formal.formal) return;
    setOperationError('');
    try {
      await studioWorkspace(scope, 'shot_end_frame_clear', { id: shot.id });
      await pollStudioExecutions();
    } catch (error) { setOperationError(workspaceError(error)); }
  };
  const addShot = () => {
    if (formal.formal) {
      setAdding(true); setOperationError('');
      void studioWorkspace<{ item?: { scene_id: string } }>(scope, 'script_insert', { data: { afterId: shot?.id } }).then(async result => {
        if (result.item) setSelected(result.item.scene_id);
        await pollStudioExecutions();
      }, error => setOperationError(workspaceError(error))).finally(() => setAdding(false));
      return;
    }
    const id = crypto.randomUUID();
    edit(episode.id, { shots: [...episode.shots, { id, title: `SHOT ${String(shots.length + 1).padStart(2, '0')}`, description: '', duration: 5 }] });
    setSelected(id);
  };
  return <div ref={root} className="flex h-full min-h-0 flex-col">
    <header className="shrink-0 border-b border-canvas-border">
      <div className="flex h-11 items-center gap-3 px-4">
        <span className="text-xs text-canvas-text-muted">{String(project.episodes.indexOf(episode) + 1).padStart(2, '0')}</span>
        <input className="ui-input min-w-0 flex-1 font-medium" aria-label={t('分集名称')} maxLength={100} value={episode.name} onChange={e => edit(episode.id, { name: e.target.value })} />
        <details className="relative shrink-0 text-xs"><summary className="ui-btn ui-btn--ghost ui-btn--sm cursor-pointer">{t('制作进度')} · {active.length ? `${active.length} ${t('执行中')}` : `${completed}/${tasks.length}`}</summary>
          <div className="absolute right-0 top-full z-20 mt-2 w-64 space-y-2 rounded-lg border border-canvas-border bg-canvas-surface p-3 shadow-lg">
            {!tasks.length && <p>{t('暂无制作任务')}</p>}{tasks.map(task => <p key={task.task_id} className="flex justify-between gap-3"><span className="truncate">{task.resource_id} · {task.task_type}</span><span>{t(task.status === 'succeeded' ? '已完成' : task.status === 'running' ? '执行中' : task.status === 'queued' ? '排队中' : task.status)}</span></p>)}
          </div>
        </details>
      </div>
      <div className="flex min-h-10 items-center justify-between gap-2 px-4">
        <Tabs aria-label={t('分集视图')} size="sm" value={view} onChange={value => setStage(value === 'plan' ? 'story' : value === 'board' ? 'shots' : 'delivery')}
          items={[{ value: 'plan', label: t('脚本规划') }, { value: 'board', label: t(project.generationMode === 'reference_video' ? '视频单元' : '分镜') }, { value: 'edit', label: t('剪辑') }]} />
        <button className="ui-btn ui-btn--ghost ui-btn--sm shrink-0" onClick={onAsk}>{t('与 Agent 协作')}<ArrowRight size={13} /></button>
      </div>
    </header>
    {view === 'plan' && <div className="ui-scroll min-h-0 flex-1 overflow-y-auto p-5">
      <div className="mx-auto max-w-3xl space-y-5">
        {project.contentMode === 'ad' ? <StudioProductionSetup project={project} episode={episode} /> : <StudioPlanning project={project} episode={episode} />}
        <div className="flex items-center justify-between"><div><h2 className="text-base font-semibold">{t(project.contentMode === 'ad' ? '广告脚本' : formal.formal ? '脚本规划' : '本集原文')}</h2><p className="mt-2 text-xs text-canvas-text-muted">{t(formal.formal ? '查看正式脚本与镜头安排。' : project.contentMode === 'ad' ? '根据广告 brief 和商品素材生成正式脚本。' : '填写本集原文，再与 Agent 规划脚本。')}</p></div><FileText size={20} className="text-canvas-text-muted" /></div>
        {formal.formal && <><ScriptStatus loading={formal.loading} error={formal.error} />{shots.map(s => <article className="rounded-lg border border-canvas-border bg-canvas-surface p-4" key={s.id}><div className="mb-3 flex justify-between text-xs"><strong>{s.title}</strong><span>{s.duration}s</span></div><p className="whitespace-pre-wrap text-sm leading-7">{s.description}</p></article>)}{project.contentMode !== 'ad' && <button className="ui-btn ui-btn--sm" aria-expanded={sourceOpen} onClick={() => setSourceOpen(!sourceOpen)}>{t(sourceOpen ? '收起本集原文' : '查看本集原文')}</button>}</>}
        {project.contentMode !== 'ad' && (!formal.formal || sourceOpen) && <>{registeredSource.length > 0 && <section className="space-y-2"><h3 className="text-sm">已登记的本集故事</h3><StudioArtifactGrid artifacts={registeredSource} /></section>}<label className="block text-xs text-canvas-text-secondary">本地原文草稿<textarea id="studio-script" maxLength={200000} className="studio-script ui-scroll mt-2 rounded-lg border border-canvas-border bg-canvas-surface" value={episode.script} onChange={e => edit(episode.id, { script: e.target.value })} placeholder="可以粘贴已有剧本，也可以直接让 Agent 创作故事并拆分镜。" /><span className="mt-2 block text-[11px] text-canvas-text-muted">本地草稿自动保存；点击“同步本集原文”后才更新制作项目。Agent 已登记的故事显示在上方。</span></label></>}
      </div>
    </div>}
    {view === 'board' && project.generationMode === 'reference_video' && <StudioReferenceVideo project={project} episode={episode} />}
    {view === 'board' && project.generationMode !== 'reference_video' && <div className={`studio-shot-split min-h-0 flex-1 ${listCollapsed ? 'is-list-collapsed' : ''}`}>
      <aside className="ui-scroll flex min-h-0 flex-col overflow-y-auto border-r border-canvas-border" aria-label={t('镜头列表')}>
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-canvas-border px-2 text-xs">{!listCollapsed && <span>{t('分镜')} · {shots.length}</span>}{!listCollapsed && <button className="ui-btn ui-btn--ghost ui-btn--sm" disabled={adding} onClick={addShot} aria-label={t('添加镜头')}><Plus size={14} /></button>}<button className="ui-btn ui-btn--ghost ui-btn--sm" aria-label={t(listCollapsed ? '展开镜头列表' : '收起镜头列表')} aria-expanded={!listCollapsed} onClick={() => setListCollapsed(!listCollapsed)}>{listCollapsed ? <PanelLeftOpen size={13} /> : <PanelLeftClose size={13} />}</button></div>
        <div className="space-y-2 p-2">{shots.map((item, i) => <button key={item.id} className={`studio-shot-item ${shot?.id === item.id ? 'is-active' : ''}`} aria-current={shot?.id === item.id ? 'true' : undefined} onClick={() => setSelected(item.id)}>
          {listCollapsed ? <span className="block text-center text-[11px]" title={item.title}>{i + 1}</span> : <>{item.image?.url ? <img className="aspect-video w-full rounded object-cover" src={item.image.url} alt={item.title} /> : <div className="flex aspect-video items-center justify-center rounded bg-canvas-card"><Image size={20} className="text-canvas-text-muted" /></div>}<span className="mt-2 flex justify-between gap-1 text-xs"><span className="truncate">{String(i + 1).padStart(2, '0')} · {item.title}</span><span>{item.duration}s</span></span></>}
        </button>)}</div>
      </aside>
      <div className="studio-shot-body flex min-h-0 min-w-0 flex-col">
        <ScriptStatus loading={formal.loading} error={formal.error} />
        {operationError && <p role="alert" className="ui-alert m-3 text-xs">{t(operationError)}</p>}
        {shot ? <>
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-canvas-border px-4"><span className="text-xs font-medium">{shot.title} · {index + 1}/{shots.length}</span><div className="flex gap-1"><button className="ui-btn ui-btn--ghost ui-btn--sm" aria-label={t('上一个镜头')} disabled={index <= 0} onClick={() => setSelected(shots[index - 1].id)}><ArrowLeft size={14} /></button><button className="ui-btn ui-btn--ghost ui-btn--sm" aria-label={t('下一个镜头')} disabled={index >= shots.length - 1} onClick={() => setSelected(shots[index + 1].id)}><ArrowRight size={14} /></button></div></div>
          <div className="studio-shot-detail ui-scroll min-h-0 flex-1 overflow-y-auto">
            <div className="space-y-5 p-4">
              {!formal.formal && <label className="block text-xs">{t('镜头名称')}<input className="ui-input mt-2 w-full" maxLength={100} value={shot.title} onChange={e => patchShot({ title: e.target.value })} /></label>}
              <label className="flex items-center gap-2 text-xs">{t('镜头时长')}<span className="w-20 shrink-0"><input type="number" min={1} max={120} className="ui-input" readOnly={formal.formal} value={shot.duration} onChange={e => patchShot({ duration: Math.max(1, Math.min(120, Number(e.target.value) || 1)) })} /></span> s</label>
              <label className="block text-xs">{t('画面描述')}<textarea className="ui-input mt-2 w-full resize-y text-xs leading-6" rows={5} readOnly={formal.formal} value={shot.description} onChange={e => patchShot({ description: e.target.value })} /></label>
              {formal.formal && <><Prompt label={t('图片提示词')} value={shot.imagePrompt} /><Prompt label={t('视频提示词')} value={shot.videoPrompt} /><StudioScriptEditor scope={scope} shotId={shot.id} /><button className="ui-btn ui-btn--sm" onClick={onAsk}>{t('在 Agent 中修改')}</button></>}
            </div>
            <div className="space-y-5 border-l border-canvas-border bg-canvas-surface/40 p-4">
              <div>
                <Media label={t('分镜图（首帧）')} artifact={shot.image} />
                <div className="mt-2 flex flex-wrap gap-2">
                  <StudioUpload scope={scope} kind="storyboard" name={shot.id} label="上传本地分镜图" accept=".png,.jpg,.jpeg,.webp" resolveTarget={ensureFormalShot} />
                  {formal.formal && <StudioVersions scope={scope} category="storyboards" name={shot.id} artifacts={execution?.artifacts ?? noArtifacts} />}
                </div>
                <StudioShotGenerate key={`${episode.id}/${shot.id}/image`} scope={scope} shotId={shot.id} kind="image" formal={formal.formal} promptReady={!!shot.imagePrompt} imageReady={!!shot.image} ensureFormalShot={ensureFormalShot} />
              </div>
              <div className="border-t border-canvas-border pt-4">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-xs font-medium">{t('尾帧图（可选，用于首尾帧生视频）')}</h3>
                  {shot.endFrame && <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => void clearEndFrame()}>{t('清除尾帧')}</button>}
                </div>
                {shot.endFrame?.url && <img className="mb-2 max-h-48 w-full rounded border border-canvas-border bg-canvas-bg object-contain" src={shot.endFrame.url} alt="尾帧图" />}
                <StudioUpload scope={scope} kind="end_frame" name={shot.id} label={shot.endFrame ? '替换本地尾帧图' : '上传本地尾帧图'} accept=".png,.jpg,.jpeg,.webp" resolveTarget={ensureFormalShot} />
              </div>
              <div className="border-t border-canvas-border pt-4">
                <Media label={t('镜头视频')} artifact={shot.video} />
                <div className="mt-2 flex flex-wrap gap-2">
                  <StudioUpload scope={scope} kind="video" name={shot.id} label="上传本地视频" accept=".mp4,.mov,.m4v,.webm" resolveTarget={ensureFormalShot} />
                  {formal.formal && <StudioVersions scope={scope} category="videos" name={shot.id} artifacts={execution?.artifacts ?? noArtifacts} />}
                </div>
                <StudioShotGenerate key={`${episode.id}/${shot.id}/video`} scope={scope} shotId={shot.id} kind="video" formal={formal.formal} promptReady={!!shot.videoPrompt} imageReady={!!shot.image} ensureFormalShot={ensureFormalShot} />
              </div>
              {active.filter(task => task.resource_id === shot.id).map(task => <p key={task.task_id} className="text-xs text-canvas-text-secondary">{task.task_type} · {t('执行中')}</p>)}
            </div>
          </div>
        </> : !formal.loading && !formal.error && <Empty title={t('暂无分镜')} detail={t('在脚本规划中准备本集内容，或点击左侧“+”添加手工镜头后直接上传本地图片与视频。')} />}
      </div>
    </div>}
    {view === 'edit' && <StudioTimeline scope={scope} artifacts={execution?.artifacts ?? noArtifacts} onAsk={onAsk} />}
  </div>;
}
function Prompt({ label, value }: { label: string; value?: string }) {
  const t = useT();
  return <div><h3 className="mb-2 text-xs font-medium">{label}</h3><pre className="whitespace-pre-wrap break-words rounded-lg border border-canvas-border p-3 font-sans text-xs leading-6 text-canvas-text-secondary">{value || t('尚未生成')}</pre></div>;
}
function Media({ label, artifact }: { label: string; artifact?: StudioArtifact }) {
  const t = useT();
  return <section><h3 className="mb-2 text-xs font-medium">{label}</h3><div className="flex min-h-36 items-center justify-center overflow-hidden rounded-lg border border-canvas-border bg-canvas-bg">
    {artifact?.url ? artifact.kind === 'video' ? <video className="max-h-96 w-full" controls src={artifact.url} preload="metadata" /> : <img className="max-h-96 w-full object-contain" src={artifact.url} alt={label} /> : <div className="flex flex-col items-center gap-3 py-6 text-canvas-text-muted"><Film size={23} /><span className="text-xs">{t('尚未上传或生成')}</span></div>}
  </div>{artifact && <p className="mt-2 text-[10px] text-canvas-text-muted">{t(artifact.imported ? '已保存在本地记录并进入个人资源库' : '已保存在本地项目，入库未完成可重试')}</p>}</section>;
}
function ScriptStatus({ loading, error }: { loading: boolean; error?: boolean }) {
  const t = useT();
  return loading || error ? <p role={error ? 'alert' : 'status'} className="p-4 text-xs text-canvas-text-muted">{t(error ? '正式剧本读取失败，请在文件中查看原文件。' : '正在读取正式剧本…')}</p> : null;
}
export function Empty({ title, detail }: { title: string; detail: string }) {
  return <div className="flex min-h-48 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"><Layers3 size={25} className="text-canvas-text-muted" /><h3 className="text-sm font-medium">{title}</h3><p className="max-w-md text-xs leading-6 text-canvas-text-muted">{detail}</p></div>;
}
