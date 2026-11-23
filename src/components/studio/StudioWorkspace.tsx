import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ArrowLeft, ArrowRight, BookOpen, Bot, Clapperboard, FolderTree, Landmark, LayoutDashboard, Library, Package, PanelLeftClose, PanelLeftOpen, Plus, Save, Search, Users, X } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { useT } from '../../i18n';
import type { StudioArtifact } from '../../types/studio';
import StudioAgentPanel from './StudioAgentPanel';
import StudioEpisodeView, { Empty } from './StudioEpisodeView';
import StudioResizeHandle from './StudioResizeHandle';
import { useStudioLayout } from './useStudioLayout';
import { StudioArtifactGrid } from './StudioResults';
import Select from '../shared/Select';
import ModalOverlay from '../shared/ModalOverlay';
import { pollStudioExecutions, studioRequest } from '../../services/studioExecutionService';
import StudioAssetEditor from './StudioAssetEditor';
import StudioUpload from './StudioUpload';
import StudioProductionSetup from './StudioProductionSetup';
import StudioLegacyMerge from './StudioLegacyMerge';
import { useWorkspaceQuery } from './useWorkspaceQuery';
import { StudioStylePicker } from './StudioStylePicker';
import { isStyleDraftComplete, type StudioStylePickerValue } from './styleTemplates';
import StudioRatioPicker from './StudioRatioPicker';
import { draftFromStoredStudioRatio, resolveStudioRatioDraft, type StudioRatioDraft } from './studioRatios';
import { studioWorkspace, uploadStudioLocalFile } from '../../services/studioWorkspaceService';

type View = 'overview' | 'episodes' | 'characters' | 'scenes' | 'props' | 'files' | 'episode' | 'products';
const navigation = [
  { id: 'overview', label: '项目概览', icon: LayoutDashboard }, { id: 'episodes', label: '分集', icon: BookOpen },
  { id: 'characters', label: '角色', icon: Users }, { id: 'scenes', label: '场景', icon: Landmark },
  { id: 'products', label: '商品', icon: Package }, { id: 'props', label: '道具', icon: Package }, { id: 'files', label: '文件', icon: FolderTree },
] as const;
function openLibrary() { useAppStore.getState().setAssetsPanelOpen(true, 'modal', { tab: 'permanent' }); }
function readView(): View {
  try {
    const value = localStorage.getItem('huanggua-studio-view');
    if (value === 'episode' || navigation.some(item => item.id === value)) return value as View;
  } catch { /* View preferences are optional. */ }
  return 'overview';
}

export default function StudioWorkspace() {
  const t = useT();
  const state = useAppStore(useShallow(s => ({ draft: s.studioDraft, load: s.studioLoad, save: s.studioSave,
    loadStudio: s.loadStudio, saveStudio: s.saveStudio, create: s.createStudioProject, selectProject: s.selectStudioProject,
    addEpisode: s.addStudioEpisode, selectEpisode: s.selectStudioEpisode, setStage: s.setStudioStage, executions: s.studioExecutions })));
  const layout = useStudioLayout();
  const [view, setView] = useState<View>(readView);
  const [lobby, setLobby] = useState(false);
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [newProject, setNewProject] = useState(false);
  const [createStep, setCreateStep] = useState<1 | 2>(1);
  const [creatingProject, setCreatingProject] = useState(false);
  const [name, setName] = useState('');
  const [contentMode, setContentMode] = useState<'drama' | 'ad'>('drama');
  const [generationMode, setGenerationMode] = useState<'storyboard' | 'reference_video'>('storyboard');
  const [newProjectRatioDraft, setNewProjectRatioDraft] = useState<StudioRatioDraft>(() => draftFromStoredStudioRatio('9:16', null));
  const [newProjectStyle, setNewProjectStyle] = useState<StudioStylePickerValue>({
    mode: 'template',
    templateId: null,
    activeCategory: 'live',
    uploadedFile: null,
    uploadedPreview: null,
  });
  const agentToggle = useRef<HTMLButtonElement>(null);
  const agentFrame = useRef<HTMLDivElement>(null);
  const loadStudio = state.loadStudio;
  useEffect(() => { void loadStudio(); }, [loadStudio]);
  const project = state.draft.projects.find(p => p.id === state.draft.projectId);
  const episode = project?.episodes.find(e => e.id === state.draft.episodeId);
  const projectInfo = useWorkspaceQuery<{ project: Record<string, Record<string, unknown>> | null }>(
    { projectId: project?.id ?? '', episodeId: episode?.id ?? '' }, 'project', undefined,
    !!project && !!episode && !lobby && view === 'overview',
  );
  const routeKey = `${project?.id}/${view}/${view === 'episode' ? episode?.id : ''}/${layout.compact}`;
  const autoCollapse = layout.compact || view === 'episode' || view === 'episodes';
  const collapsed = autoCollapse ? expandedFor !== routeKey : layout.collapsed;
  const toggleSidebar = () => autoCollapse ? setExpandedFor(collapsed ? routeKey : null) : layout.setCollapsed(!collapsed);
  const changeView = (next: View) => {
    setExpandedFor(null); setView(next);
    if (['characters', 'scenes', 'props', 'products'].includes(next)) state.setStage('assets');
    if (next === 'overview' || next === 'episodes') state.setStage('story');
    try { localStorage.setItem('huanggua-studio-view', next); } catch { /* Keep in-memory navigation. */ }
  };
  useEffect(() => {
    const navigateToStyle = () => {
      setLobby(false);
      setExpandedFor(null);
      setView('overview');
      state.setStage('story');
      try { localStorage.setItem('huanggua-studio-view', 'overview'); } catch { /* ignore */ }
      setTimeout(() => window.dispatchEvent(new Event('studio-open-style-dialog')), 80);
    };
    window.addEventListener('studio-navigate-style', navigateToStyle);
    return () => window.removeEventListener('studio-navigate-style', navigateToStyle);
  }, [state]);
  const openEpisode = (id: string) => {
    state.selectEpisode(id);
    const hasScript = state.executions[`${project?.id}/${id}`]?.artifacts.some(a => a.name.startsWith('scripts/') && a.name.endsWith('.json'));
    state.setStage(hasScript ? 'shots' : 'story'); changeView('episode');
  };
  const ask = () => { layout.setAgentOpen(true); requestAnimationFrame(() => document.getElementById('studio-brief')?.focus()); };
  const closeAgent = () => { layout.setAgentOpen(false); agentToggle.current?.focus(); };
  const artifacts: StudioArtifact[] = [...new Map((project?.episodes.flatMap(e => state.executions[`${project.id}/${e.id}`]?.artifacts ?? []) ?? []).map(a => [a.name, a])).values()];
  const visibleArtifacts = artifacts.filter(a => !a.name.startsWith('versions/'));
  const tasks = [...new Map((project?.episodes.flatMap(e => state.executions[`${project.id}/${e.id}`]?.tasks ?? []) ?? []).map(task => [task.task_id, task])).values()];
  const active = tasks.filter(task => ['queued', 'running'].includes(task.status));
  const title = navigation.find(item => item.id === view)?.label ?? '分集';
  const ready = !!project && !!episode && !lobby;
  const addEpisode = () => { if (!project) return; state.addEpisode(`EP ${String(project.episodes.length + 1).padStart(2, '0')}`); state.setStage('story'); changeView('episode'); };
  const resolvedNewProjectRatio = resolveStudioRatioDraft(newProjectRatioDraft);
  const openCreateModal = () => {
    setCreateStep(1);
    setName('');
    setContentMode('drama');
    setGenerationMode('storyboard');
    setNewProjectRatioDraft(draftFromStoredStudioRatio('9:16', null));
    setNewProjectStyle({ mode: 'template', templateId: null, activeCategory: 'live', uploadedFile: null, uploadedPreview: null });
    setNewProject(true);
  };
  const submitCreateProject = async () => {
    if (!name.trim() || !resolvedNewProjectRatio.valid || !isStyleDraftComplete(newProjectStyle) || creatingProject) return;
    setCreatingProject(true);
    const chosenTpl = newProjectStyle.mode === 'template' ? newProjectStyle.templateId : null;
    const created = state.create(
      name,
      contentMode,
      generationMode,
      chosenTpl,
      resolvedNewProjectRatio.aspectRatio,
      resolvedNewProjectRatio.customResolution,
    );
    setNewProject(false);
    setName('');
    setLobby(false);
    changeView('overview');
    if (created) {
      const createdScope = { projectId: created.projectId, episodeId: created.episodeId };
      try {
        await studioWorkspace(createdScope, 'project_settings', {
          data: {
            aspect_ratio: resolvedNewProjectRatio.aspectRatio,
            custom_resolution: resolvedNewProjectRatio.customResolution,
            ...(chosenTpl ? { style_template_id: chosenTpl, clear_style_image: true } : {}),
          },
        });
        if (newProjectStyle.mode === 'custom' && newProjectStyle.uploadedFile) {
          await uploadStudioLocalFile(createdScope, 'style_image', newProjectStyle.uploadedFile);
        }
        projectInfo.refresh();
      } catch {
        /* Runtime may still be warming up; local styleTemplateId and ratio are persisted on StudioProject. */
      }
    }
    setCreatingProject(false);
  };
  const dialog = <ModalOverlay isOpen={newProject} onClose={() => !creatingProject && setNewProject(false)} ariaLabel={t('新建短剧项目')} zIndex={400} className={`ui-scroll max-h-[88vh] overflow-y-auto p-6 ${createStep === 2 ? 'w-[min(780px,calc(100vw-32px))]' : 'w-[min(460px,calc(100vw-32px))]'}`}>
    <form onSubmit={event => { event.preventDefault(); if (createStep === 1) { if (name.trim() && resolvedNewProjectRatio.valid) setCreateStep(2); return; } void submitCreateProject(); }}>
      <div className="mb-4 flex items-center justify-between"><div className="space-y-1"><h2 className="text-lg font-semibold">{t('新建短剧项目')}</h2><p className="text-xs text-canvas-text-muted">{createStep === 1 ? '第 1 / 2 步 · 基础信息' : '第 2 / 2 步 · 画面风格（必选模版或上传参考图）'}</p></div><button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" aria-label={t('关闭')} disabled={creatingProject} onClick={() => setNewProject(false)}><X size={16} /></button></div>
      {createStep === 1 ? <>
        <label className="block text-sm">{t('项目名称')}<input autoFocus required maxLength={100} value={name} onChange={e => setName(e.target.value)} className="ui-input mt-2 w-full" placeholder={t('给你的故事起个名字')} /></label>
        <div className="mt-4 grid grid-cols-2 gap-3"><label className="text-sm">内容类型<Select aria-label="内容类型" className="mt-2 w-full" value={contentMode} onChange={value => setContentMode(value as 'drama' | 'ad')} options={[{ value: 'drama', label: '短剧' }, { value: 'ad', label: '广告 / 短片' }]} /></label><label className="text-sm">制作方式<Select aria-label="生成方式" className="mt-2 w-full" value={generationMode} onChange={value => setGenerationMode(value as 'storyboard' | 'reference_video')} options={[{ value: 'storyboard', label: '分镜图生视频' }, { value: 'reference_video', label: '参考生视频' }]} /></label></div>
        <div className="mt-4">
          <StudioRatioPicker
            label="默认画幅 / 分辨率"
            ariaLabel="默认画幅"
            value={newProjectRatioDraft}
            onChange={setNewProjectRatioDraft}
          />
        </div>
        <p className="mt-3 text-xs text-canvas-text-muted">创建后制作方式固定；广告项目只有一集。</p><p className="my-4 text-xs leading-6 text-canvas-text-muted">{t('项目将保存到本机，可先编写剧本和分镜。')}</p>
        <button type="submit" className="ui-btn ui-btn--primary w-full" disabled={!name.trim() || !resolvedNewProjectRatio.valid}>下一步 · 选择画面风格<ArrowRight size={15} /></button>
      </> : <>
        <p className="mb-3 text-xs leading-6 text-canvas-text-secondary">请选择一个内置画面风格模版，或切换到「自定义」上传一张本地风格参考图，两者必选其一。</p>
        <StudioStylePicker value={newProjectStyle} onChange={setNewProjectStyle} />
        <div className="mt-5 flex items-center justify-between gap-3 border-t border-canvas-border pt-4">
          <button type="button" className="ui-btn" disabled={creatingProject} onClick={() => setCreateStep(1)}>上一步</button>
          <span className="flex-1 text-right text-xs text-canvas-text-muted">{!isStyleDraftComplete(newProjectStyle) ? '请先选择一个风格模版或上传一张风格参考图' : ''}</span>
          <button type="submit" className="ui-btn ui-btn--primary" disabled={!isStyleDraftComplete(newProjectStyle) || creatingProject}>{t('创建项目')}<ArrowRight size={15} /></button>
        </div>
      </>}
    </form>
  </ModalOverlay>;
  if (state.load !== 'ready') return <section className="huanggua-studio flex items-center justify-center bg-canvas-bg"><div className="text-center"><p className="text-sm text-canvas-text-secondary">{t(state.load === 'error' ? '无法读取短剧草稿，请重试。' : '正在读取短剧草稿…')}</p>{state.load === 'error' && <button className="ui-btn mt-4" onClick={() => void state.loadStudio()}>{t('重试')}</button>}</div></section>;
  return <section className="huanggua-studio flex flex-col bg-canvas-bg" aria-label={t('短剧工作区')}>
    <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-canvas-border px-3">
      <div className="flex min-w-0 items-center gap-2"><button className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => setLobby(true)}><ArrowLeft size={14} />{t('项目')}</button>{ready && <><span className="h-4 border-l border-canvas-border" /><Select className="min-w-0 max-w-64" aria-label={t('当前短剧')} value={project.id} options={state.draft.projects.map(p => ({ value: p.id, label: p.name }))} onChange={id => { state.selectProject(id); changeView('overview'); }} /></>}</div>
      {ready && <span className="hidden truncate text-xs text-canvas-text-muted md:block" role="status">{active.length ? `${active.length} ${t('个任务执行中')}` : t('短剧工作区')}</span>}
      <div className="flex shrink-0 items-center gap-2">{ready && <><span role="status" className="hidden text-[11px] text-canvas-text-muted lg:block">{t(state.save === 'saving' ? '正在保存…' : state.save === 'error' ? '保存失败，请重试' : '已保存到本机')}</span><button className="ui-btn ui-btn--ghost ui-btn--sm" aria-label={t('保存')} onClick={() => void state.saveStudio()}><Save size={14} /></button><button ref={agentToggle} className={`ui-btn ui-btn--sm ${layout.agentOpen ? 'is-active' : ''}`} aria-expanded={layout.agentOpen} aria-controls="studio-agent-panel" onClick={() => layout.setAgentOpen(!layout.agentOpen)}><Bot size={15} />Agent</button></>}<button className="ui-btn ui-btn--sm" onClick={openCreateModal}><Plus size={14} />{t('新建项目')}</button></div>
    </header>
    {!ready ? <div className="ui-scroll min-h-0 flex-1 overflow-y-auto p-6"><div className="mx-auto max-w-6xl"><div className="mb-6 flex items-center gap-3"><Clapperboard size={22} /><h1 className="text-xl font-semibold">{t('短剧项目')}</h1></div><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"><button className="studio-project-card flex min-h-48 flex-col items-center justify-center gap-3 border-dashed" onClick={openCreateModal}><Plus size={26} /><span>{t('新建短剧项目')}</span></button>{state.draft.projects.map(p => <button className="studio-project-card text-left" key={p.id} onClick={() => { state.selectProject(p.id); setLobby(false); changeView('overview'); }}><Clapperboard size={27} className="mb-8 text-[var(--brand-light)]" /><h2 className="truncate text-sm font-medium">{p.name}</h2><p className="mt-3 text-xs text-canvas-text-muted">{p.episodes.length} {t('集')}</p></button>)}</div></div></div>
      : <div className={`studio-workbench ${collapsed ? 'is-sidebar-collapsed' : ''} ${layout.agentOpen ? 'is-agent-open' : ''} ${layout.compact ? 'is-compact' : ''}`}
        style={{ '--studio-sidebar-width': `${layout.sidebarWidth}px`, '--studio-agent-width': `${layout.agentWidth}px` } as CSSProperties}>
        <aside className="studio-sidebar flex min-h-0 flex-col bg-canvas-surface" aria-label={t('工作区导航')}>
          <nav className="space-y-1 p-2">{navigation.filter(item => project.contentMode === 'ad' ? item.id !== 'episodes' : item.id !== 'products').map(item => <button key={item.id} title={t(item.label)} aria-label={t(item.label)} aria-current={view === item.id ? 'page' : undefined} className={`studio-nav-item ${view === item.id ? 'is-active' : ''}`} onClick={() => changeView(item.id)}><item.icon size={17} /><span className="studio-sidebar-label flex-1 text-left">{t(item.label)}</span>{item.id === 'episodes' && <span className="studio-sidebar-label text-[10px] text-canvas-text-muted">{project.episodes.length}</span>}</button>)}</nav>
          <div className="border-t border-canvas-border" />
          <div className="flex items-center justify-between px-3 py-3"><span className="studio-sidebar-label text-xs text-canvas-text-secondary">{t(project.contentMode === 'ad' ? '广告 / 短片' : '分集')} · {project.episodes.length}</span>{project.contentMode !== 'ad' && <button className="ui-btn ui-btn--ghost ui-btn--sm" aria-label={t('添加分集')} onClick={addEpisode}><Plus size={14} /></button>}</div>
          {!collapsed && project.contentMode !== 'ad' && <label className="relative mx-3 mb-3"><Search size={13} className="absolute left-2 top-2 text-canvas-text-muted" /><input className="ui-input w-full pl-7 text-xs" aria-label={t('搜索分集')} placeholder={t('搜索分集')} value={search} onChange={e => setSearch(e.target.value)} /></label>}
          <div className="ui-scroll min-h-0 flex-1 space-y-1 overflow-y-auto p-2">{project.episodes.map((item, i) => ({ item, i })).filter(({ item, i }) => collapsed || !search || item.name.includes(search) || String(i + 1).includes(search)).map(({ item, i }) => <button key={item.id} title={item.name} aria-label={`${i + 1} ${item.name}`} aria-current={view === 'episode' && item.id === episode.id ? 'page' : undefined} className={`studio-nav-item ${view === 'episode' && item.id === episode.id ? 'is-active' : ''}`} onClick={() => openEpisode(item.id)}><span className="w-5 shrink-0 text-[11px] tabular-nums">{String(i + 1).padStart(2, '0')}</span><span className="studio-sidebar-label min-w-0 text-left"><span className="block truncate">{item.name}</span><span className="mt-1 block text-[10px] text-canvas-text-muted">{t(item.script ? '已填写剧本' : '待编写')}</span></span></button>)}</div>
          <div className="space-y-1 border-t border-canvas-border p-2"><button className="studio-nav-item" title={t('个人资源库')} onClick={openLibrary}><Library size={17} /><span className="studio-sidebar-label">{t('个人资源库')}</span></button><button className="studio-nav-item" title={t(collapsed ? '展开侧栏' : '收起侧栏')} aria-expanded={!collapsed} onClick={toggleSidebar}>{collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}<span className="studio-sidebar-label">{t('收起侧栏')}</span></button></div>
        </aside>
        {!collapsed && <StudioResizeHandle label={t('调整侧栏宽度')} value={layout.sidebarWidth} min={200} max={320} initial={256} onChange={layout.setSidebarWidth} />}
        <main className="studio-main flex min-h-0 min-w-0 flex-1 flex-col">
          {view === 'episode' ? <StudioEpisodeView key={episode.id} project={project} episode={episode} onAsk={ask} /> : <>
            <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-canvas-border px-5"><h1 className="text-sm font-semibold">{t(title)}</h1>{view === 'episodes' && <button className="ui-btn ui-btn--sm" onClick={addEpisode}><Plus size={14} />{t('新建一集')}</button>}{['characters', 'scenes', 'props', 'products', 'files'].includes(view) && <div className="flex gap-2"><button className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => void pollStudioExecutions()}>{t('刷新与重试入库')}</button><button className="ui-btn ui-btn--ghost ui-btn--sm" onClick={openLibrary}><Library size={14} />{t('个人资源库')}</button></div>}</div>
            <div className="ui-scroll min-h-0 flex-1 overflow-y-auto p-6">
              {view === 'overview' && <div className="max-w-3xl space-y-6"><StudioLegacyMerge project={project} episode={episode} /><StudioProductionSetup project={project} episode={episode} /><div><h2 className="text-2xl font-semibold">{project.name}</h2><p className="mt-3 text-xs text-canvas-text-muted">{project.episodes.length} {t('集')} · {visibleArtifacts.length} {t('个本地记录与生成资源')}</p></div><section className="rounded-lg border border-canvas-border bg-canvas-surface p-5"><h3 className="text-sm font-medium">{t(project.contentMode === 'ad' ? '广告制作' : '故事内容')}</h3><p className="mt-4 whitespace-pre-wrap text-sm leading-7 text-canvas-text-secondary">{episode.script || t(project.contentMode === 'ad' ? '从广告脚本开始，继续编辑视频单元与成片。' : '从分集开始，写下你的故事。')}</p><button className="ui-btn ui-btn--sm mt-5" onClick={() => openEpisode(episode.id)}>{t(project.contentMode === 'ad' ? '打开作品' : '打开分集')}<ArrowRight size={14} /></button></section><div className="grid grid-cols-3 gap-3">{navigation.filter(item => ['characters', 'scenes', 'props', ...(project.contentMode === 'ad' ? ['products'] : [])].includes(item.id)).map(item => <button key={item.id} className="rounded-lg border border-canvas-border bg-canvas-surface p-4 text-left hover:bg-canvas-hover" onClick={() => changeView(item.id)}><item.icon size={18} className="mb-3 text-canvas-text-muted" /><span className="text-xs">{t(item.label)} · {projectInfo.data ? Object.keys(projectInfo.data.project?.[item.id] ?? {}).length : '—'}</span></button>)}</div></div>}
              {view === 'episodes' && <div className="space-y-3">{project.episodes.map((item, i) => <button className="flex w-full items-center gap-4 rounded-lg border border-canvas-border bg-canvas-surface p-5 text-left hover:bg-canvas-hover" key={item.id} onClick={() => openEpisode(item.id)}><span className="text-lg tabular-nums text-canvas-text-muted">{String(i + 1).padStart(2, '0')}</span><div className="min-w-0 flex-1"><h2 className="truncate text-sm font-medium">{item.name}</h2><p className="mt-2 truncate text-xs text-canvas-text-muted">{item.script || t('待编写')}</p></div><ArrowRight size={15} /></button>)}</div>}
              {['characters', 'scenes', 'props', 'products'].includes(view) && <StudioAssetEditor key={`${episode.id}/${view}`} project={project} episode={episode} category={view} artifacts={artifacts.filter(a => a.name.startsWith(`${view}/`) || a.name.startsWith('versions/') || a.name.startsWith('audio/') || a.name.startsWith(`uploads/assets/${view}/`))} />}
              {view === 'files' && <><div className="mb-4 flex flex-wrap items-center gap-3">
                <StudioUpload scope={{ projectId: project.id, episodeId: episode.id }} kind="local_media" label="上传本地图片 / 视频" accept=".png,.jpg,.jpeg,.webp,.mp4,.mov,.m4v,.webm" />
                <StudioUpload scope={{ projectId: project.id, episodeId: episode.id }} kind="source" label="导入原文文件" accept=".txt,.md,.docx,.epub,.pdf" beforeUpload={async () => { await studioRequest('workspace', { projectId: project.id, episodeId: episode.id, action: 'initialize', title: `${project.name} · ${episode.name}`, episodeTitle: episode.name, sourceText: episode.script, models: episode.models ?? {} }); }} />
                <span className="text-xs text-canvas-text-muted">{episode.name} · 上传的图片与视频自动保存在本地项目记录并同步至个人资源库</span>
              </div>{visibleArtifacts.length ? <StudioArtifactGrid artifacts={visibleArtifacts} /> : <Empty title={t('暂无资源')} detail={t('本地上传的图片、视频及 Agent 生成的资源会显示在这里，并自动进入个人资源库。')} />}</>}
            </div>
          </>}
        </main>
        <div ref={agentFrame} id="studio-agent-panel" className="studio-agent-frame" hidden={!layout.agentOpen} inert={!layout.agentOpen} onKeyDown={event => { if (layout.compact && event.key === 'Escape' && !event.defaultPrevented && agentFrame.current?.contains(event.target as Node)) { event.preventDefault(); closeAgent(); } }}>
          <StudioResizeHandle label={t('调整 Agent 宽度')} value={layout.agentWidth} min={320} max={640} initial={420} reverse onChange={layout.setAgentWidth} />
          <StudioAgentPanel key={episode.id} project={project} episode={episode} isOpen={layout.agentOpen} onClose={closeAgent} />
        </div>
      </div>}
    {dialog}
  </section>;
}
