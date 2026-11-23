import { useState } from 'react';
import { Clapperboard, Infinity as InfinityIcon, FolderOpen, Library, ListChecks, Settings2, X } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { useT } from '../../i18n';
import AboutDialog from '../AboutDialog';
import Tabs from '../shared/Tabs';
import ModalOverlay from '../shared/ModalOverlay';
import HuangguaAccountButton from '../account/HuangguaAccountButton';
import { studioStatusLabels } from '../../types/studio';

export default function WorkspaceChrome() {
  const t = useT();
  const mode = useAppStore(s => s.clientWorkspaceMode);
  const setMode = useAppStore(s => s.setClientWorkspaceMode);
  const tasks = useAppStore(s => s.agentTasks);
  const studioExecutions = useAppStore(s => s.studioExecutions);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  return <>
    <header className="huanggua-chrome" data-tauri-drag-region>
      <button
        type="button"
        className="flex shrink-0 cursor-pointer items-center gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-canvas-hover"
        title={t('关于黄瓜 AI 画布')}
        aria-label={t('关于黄瓜 AI 画布')}
        onClick={() => setAboutOpen(true)}
      >
        <img src={`${import.meta.env.BASE_URL}huanggua-ai.png`} alt="" className="h-8 w-8 object-contain" />
        <span className="hidden text-sm font-semibold xl:inline">黄瓜 AI</span>
      </button>
      <Tabs aria-label={t('创作模式')} value={mode} onChange={setMode} size="sm"
        items={[
          { value: 'canvas', label: <span className="flex items-center gap-2"><InfinityIcon size={15} />{t('无限画布')}</span> },
          { value: 'drama', label: <span className="flex items-center gap-2"><Clapperboard size={15} />{t('短剧 Agent')}</span> },
        ]} />
      <div className="flex-1" data-tauri-drag-region />
      <nav className="flex items-center gap-1" aria-label={t('公共工作区')}>
        <button className="ui-btn ui-btn--ghost ui-btn--sm" title={t('画布项目')} onClick={() => {
          setMode('canvas'); useAppStore.getState().setProjectLibraryOpen(true);
        }}><FolderOpen size={16} /><span className="hidden lg:inline">{t('画布项目')}</span></button>
        <button className="ui-btn ui-btn--ghost ui-btn--sm" title={t('个人资源库')} onClick={() => useAppStore.getState().setAssetsPanelOpen(true, 'modal', { tab: 'permanent' })}>
          <Library size={16} /><span className="hidden lg:inline">{t('个人资源库')}</span></button>
        <button className="ui-btn ui-btn--ghost ui-btn--sm" title={t('任务概览')} onClick={() => setTasksOpen(true)}><ListChecks size={16} /></button>
        <button className="ui-btn ui-btn--ghost ui-btn--sm" title={t('设置')} onClick={() => useAppStore.getState().setSettingsOpen(true)}><Settings2 size={16} /></button>
        <HuangguaAccountButton compact />
      </nav>
    </header>
    <ModalOverlay isOpen={tasksOpen} onClose={() => setTasksOpen(false)} ariaLabel={t('任务概览')} zIndex={400}
      className="w-[min(560px,calc(100vw-32px))] p-6">
      <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">{t('任务概览')}</h2>
        <button className="ui-btn ui-btn--ghost ui-btn--sm" aria-label={t('关闭')} onClick={() => setTasksOpen(false)}><X size={16} /></button></div>
      <p className="my-4 text-sm text-canvas-text-secondary">{t('当前画布的 Agent 任务')}</p>
      <div className="ui-scroll max-h-72 space-y-2 overflow-y-auto">
        {tasks.length ? tasks.map(task => <div key={task.id} className="rounded-lg border border-canvas-border p-3 text-sm">
          <p className="truncate">{task.goal}</p><p className="mt-1 text-xs text-canvas-text-muted">{t(task.status)}</p>
        </div>) : <p className="rounded-xl bg-canvas-card p-6 text-center text-sm text-canvas-text-muted">{t('暂无任务')}</p>}
      </div>
      <p className="my-3 text-sm text-canvas-text-secondary">{t('短剧 Agent')}</p>
      <div className="ui-scroll max-h-48 space-y-2 overflow-y-auto">{Object.entries(studioExecutions).filter(([, e]) => e.entries.length || e.tasks.length).map(([key, e]) =>
        <div key={key} className="rounded border border-canvas-border p-2 text-xs"><p>{t(studioStatusLabels[e.status] ?? e.status)} · {e.artifacts.length} {t('生成资源')}</p>{e.tasks.map(task => <p key={task.task_id} className="mt-1 text-canvas-text-muted">{task.resource_id} · {task.status}</p>)}</div>)}</div>
    </ModalOverlay>
    <AboutDialog isOpen={aboutOpen} onClose={() => setAboutOpen(false)} />
  </>;
}
