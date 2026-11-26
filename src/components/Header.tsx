/**
 * Header 顶部栏 — Logo、项目名编辑、分集切换、窗口拖拽区域
 */
import { useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/useAppStore';
import { listEpisodes } from '../store/store.utils';
import { useT } from '../i18n';
import EpisodeNameDialog from './shared/EpisodeNameDialog';
import Select from './shared/Select';

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
const isMacOS = typeof navigator !== 'undefined'
  && /Macintosh|Mac OS X/.test(navigator.userAgent);

export default function Header() {
  const t = useT();
  const { projectName, setProjectName, projects, switchProject, isCreatingProject, returnToStartPage, isReturningToStartPage, switchingProjectName, currentProjectId, projectLoadStatus } = useAppStore(
    useShallow((s) => ({
      projectName: s.projectName,
      setProjectName: s.setProjectName,
      projects: s.projects,
      switchProject: s.switchProject,
      isCreatingProject: s.isCreatingProject,
      returnToStartPage: s.returnToStartPage,
      isReturningToStartPage: s.isReturningToStartPage,
      switchingProjectName: s.switchingProjectName,
      currentProjectId: s.currentProjectId,
      projectLoadStatus: s.projectLoadStatus,
    })),
  );
  const [episodeNameOpen, setEpisodeNameOpen] = useState(false);
  const canCreateEpisode = !!currentProjectId && projectLoadStatus === 'ready'
    && !isCreatingProject && !isReturningToStartPage && switchingProjectName === null;
  const currentProject = projects.find((project) => project.id === currentProjectId);
  const seriesId = currentProject?.parentId;
  const seriesName = seriesId ? projects.find((project) => project.id === seriesId)?.name ?? '' : '';
  const episodes = seriesId ? listEpisodes(projects, seriesId) : [];
  const macTauriPlacement = isTauri && isMacOS;

  return (
    <header
      data-tauri-drag-region
      className={`app-header absolute top-2 z-40 flex items-center gap-1 px-2 py-2
                  bg-canvas-surface/60 backdrop-blur-xl border border-canvas-border rounded-[14px]
                  shadow-lg shadow-black/30 select-none ${
                    macTauriPlacement ? 'right-2' : 'left-2'
                  }`}
    >
      {/* Logo */}
      <div className="flex items-center gap-2 pr-1">
        <button
          type="button"
          aria-label={isReturningToStartPage ? t('正在返回启动页') : t('返回启动页')}
          data-tooltip={isReturningToStartPage ? t('正在保存项目…') : t('返回启动页')}
          disabled={isReturningToStartPage || isCreatingProject || episodeNameOpen || switchingProjectName !== null}
          onClick={() => void returnToStartPage()}
          className="ui-btn ui-btn--ghost ui-btn--sm shrink-0 gap-1 px-1.5 focus-visible:ring-2 focus-visible:ring-indigo-400"
        >
          <ArrowLeft size={16} aria-hidden="true" />
          <span>{t('画布项目')}</span>
        </button>
        <span className="text-[11px] font-semibold text-canvas-text/90">{t('无限画布')}</span>
      </div>

      {/* Divider */}
      <div className="w-px h-4 bg-[var(--separator-color)] mx-0.5" />

      {/* Project Name */}
      {seriesName && (
        <>
          <span className="max-w-[110px] truncate pl-2 text-[11px] text-canvas-text-secondary/70">
            {seriesName}
          </span>
          <span className="text-[11px] text-canvas-text-muted">-</span>
        </>
      )}
      {seriesId ? (
        <Select
          key={seriesId}
          value={currentProjectId ?? ''}
          onChange={(episodeId) => {
            if (episodeId !== currentProjectId) void switchProject(episodeId);
          }}
          options={episodes.map((episode) => ({ value: episode.id, label: episode.name }))}
          aria-label={t('分集')}
          title={projectName}
          size="sm"
          className="w-[140px] shrink-0"
          triggerClassName="[&&&]:border-0 [&&&]:bg-transparent [&&&]:shadow-none
                            [&&&]:hover:bg-transparent [&&&]:focus-visible:bg-transparent
                            [&&&]:focus-visible:ring-2 [&&&]:focus-visible:ring-indigo-400/50"
          disabled={!canCreateEpisode || episodeNameOpen}
        />
      ) : (
        <div
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          onBlur={(e) => {
            const name = e.currentTarget.textContent?.trim() || t('新项目');
            setProjectName(name);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              (e.target as HTMLElement).blur();
            }
          }}
          className="text-[11px] text-canvas-text-secondary/80 px-2 py-0.5 rounded-md
                     hover:bg-canvas-hover outline-none cursor-text min-w-[50px] max-w-[140px] truncate
                     focus:text-canvas-text/90 transition-colors"
        >
          {projectName}
        </div>
      )}

      {/* Divider */}
      <div className="w-px h-4 bg-[var(--separator-color)] mx-0.5" />

      {/* Actions */}
      <motion.button
        type="button"
        aria-label={t('创建分集')}
        onClick={() => setEpisodeNameOpen(true)}
        disabled={!canCreateEpisode || episodeNameOpen}
        className="w-7 h-7 rounded-lg hover:bg-canvas-hover flex items-center justify-center
                   text-canvas-text-secondary hover:text-canvas-text disabled:cursor-not-allowed disabled:opacity-50"
        data-tooltip={t('创建分集')}
        whileHover={canCreateEpisode && !episodeNameOpen ? { scale: 1.1 } : undefined}
        whileTap={canCreateEpisode && !episodeNameOpen ? { scale: 0.92 } : undefined}
        transition={{ type: 'spring', stiffness: 400, damping: 17 }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </motion.button>
      {episodeNameOpen && <EpisodeNameDialog onClose={() => setEpisodeNameOpen(false)} />}
    </header>
  );
}
