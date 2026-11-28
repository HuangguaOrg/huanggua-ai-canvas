import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { StudioDraftDocument, StudioEpisode, StudioStage } from '../types/studio';
import { readStudioDrafts, writeStudioDrafts } from '../services/studioDraftRepository';
import { reconcileStudioDraftModels } from '../services/studioModelSelection';
import { studioWorkspace } from '../services/studioWorkspaceService';

export interface StudioSlice {
  studioDraft: StudioDraftDocument;
  studioLoad: 'idle' | 'loading' | 'ready' | 'error';
  studioSave: 'saved' | 'saving' | 'error';
  studioStage: StudioStage;
  loadStudio: () => Promise<void>;
  saveStudio: () => Promise<void>;
  setStudioStage: (stage: StudioStage) => void;
  createStudioProject: (name: string, contentMode?: 'drama' | 'ad', generationMode?: 'storyboard' | 'reference_video', styleTemplateId?: string | null, aspectRatio?: string, customResolution?: string | null) => { projectId: string; episodeId: string } | null;
  selectStudioProject: (id: string) => void;
  deleteStudioProject: (id: string) => Promise<boolean>;
  addStudioEpisode: (name: string) => void;
  selectStudioEpisode: (id: string) => void;
  editStudioEpisode: (id: string, patch: Partial<Pick<StudioEpisode, 'name' | 'script' | 'agentBrief' | 'shots' | 'models' | 'nativeVideoResolution' | 'rewriteAnchor'>>) => void;
  setStudioProjectStyleTemplate: (projectId: string, styleTemplateId: string | null) => void;
  setStudioProjectRatio: (projectId: string, aspectRatio: string, customResolution: string | null) => void;
}
export const createStudioSlice: StateCreator<AppState, [], [], StudioSlice> = (set, get) => {
  let saveQueue = Promise.resolve();
  let revision = 0;
  const change = (studioDraft: StudioDraftDocument) => {
    if (get().studioLoad !== 'ready') return;
    set({ studioDraft });
    void get().saveStudio();
  };
  return {
    studioDraft: { version: 1, projects: [], projectId: null, episodeId: null },
    studioLoad: 'idle', studioSave: 'saved', studioStage: 'story',
    loadStudio: async () => {
      if (get().studioLoad === 'loading' || get().studioLoad === 'ready') return;
      set({ studioLoad: 'loading' });
      try {
        const saved = await readStudioDrafts();
        const state = get();
        const studioDraft = state.studioConnection === 'ready'
          ? reconcileStudioDraftModels(saved, state.studioModels, state.studioVideoModelsByMode) : saved;
        set({ studioDraft, studioLoad: 'ready' });
        if (studioDraft !== saved) await get().saveStudio();
      }
      catch { set({ studioLoad: 'error' }); }
    },
    saveStudio: async () => {
      if (get().studioLoad !== 'ready') return;
      const currentRevision = ++revision;
      const snapshot = structuredClone(get().studioDraft);
      set({ studioSave: 'saving' });
      saveQueue = saveQueue.catch(() => {}).then(() => writeStudioDrafts(snapshot));
      try {
        await saveQueue;
        if (currentRevision === revision) set({ studioSave: 'saved' });
      } catch { if (currentRevision === revision) set({ studioSave: 'error' }); }
    },
    setStudioStage: (studioStage) => set({ studioStage }),
    createStudioProject: (name, contentMode = 'drama', generationMode = 'storyboard', styleTemplateId = null, aspectRatio = '9:16', customResolution = null) => {
      if (!name.trim()) return null;
      const episode: StudioEpisode = { id: crypto.randomUUID(), name: contentMode === 'ad' ? '广告作品' : 'EP 01', script: '', agentBrief: '', shots: [] };
      const project = { id: crypto.randomUUID(), name: name.trim().slice(0, 100), contentMode, generationMode, styleTemplateId, aspectRatio, customResolution, updatedAt: Date.now(), episodes: [episode] };
      change({ ...get().studioDraft, projects: [...get().studioDraft.projects, project], projectId: project.id, episodeId: episode.id });
      set({ studioStage: 'story' });
      return { projectId: project.id, episodeId: episode.id };
    },
    setStudioProjectStyleTemplate: (projectId, styleTemplateId) => {
      const d = get().studioDraft;
      change({
        ...d,
        projects: d.projects.map(p => p.id === projectId ? { ...p, styleTemplateId, updatedAt: Date.now() } : p),
      });
    },
    setStudioProjectRatio: (projectId, aspectRatio, customResolution) => {
      const d = get().studioDraft;
      change({
        ...d,
        projects: d.projects.map(p => p.id === projectId ? { ...p, aspectRatio, customResolution, updatedAt: Date.now() } : p),
      });
    },
    selectStudioProject: (id) => {
      const project = get().studioDraft.projects.find(p => p.id === id);
      if (project) change({ ...get().studioDraft, projectId: id, episodeId: project.episodes[0]?.id ?? null });
    },
    deleteStudioProject: async (id) => {
      if (get().studioLoad !== 'ready') return false;
      const project = get().studioDraft.projects.find(p => p.id === id);
      if (!project) return false;
      if (project.episodes.some(e => get().studioSubmitting[`${id}/${e.id}`])) throw 'studio_session_busy';
      const episodeId = project.episodes[0]?.id;
      if (episodeId) await studioWorkspace({ projectId: id, episodeId }, 'project_delete');
      // Read after the request: another project may have been edited meanwhile.
      const draft = get().studioDraft;
      const projects = draft.projects.filter(item => item.id !== id);
      const next = projects[0];
      const removingSelected = draft.projectId === id;
      const nextDraft = { ...draft, projects,
        projectId: removingSelected ? next?.id ?? null : draft.projectId,
        episodeId: removingSelected ? next?.episodes[0]?.id ?? null : draft.episodeId };
      set({ studioDraft: nextDraft });
      const currentRevision = ++revision;
      const snapshot = structuredClone(nextDraft);
      set({ studioSave: 'saving' });
      saveQueue = saveQueue.catch(() => {}).then(() => writeStudioDrafts(snapshot));
      try {
        await saveQueue;
        if (currentRevision === revision) set({ studioSave: 'saved' });
      } catch {
        // Keep a retryable local entry; the runtime delete operation is idempotent.
        const latest = get().studioDraft;
        set({ studioSave: 'error', studioDraft: { ...latest,
          projects: latest.projects.some(p => p.id === id) ? latest.projects : [...latest.projects, draft.projects.find(p => p.id === id) ?? project],
          ...(latest.projectId === nextDraft.projectId && latest.episodeId === nextDraft.episodeId
            ? { projectId: draft.projectId, episodeId: draft.episodeId } : {}),
        } });
        throw 'studio_save_failed';
      }
      const executionPrefix = `${id}/`;
      const executions = Object.fromEntries(Object.entries(get().studioExecutions).filter(([key]) => !key.startsWith(executionPrefix)));
      const submitting = Object.fromEntries(Object.entries(get().studioSubmitting).filter(([key]) => !key.startsWith(executionPrefix)));
      const historyLimits = Object.fromEntries(Object.entries(get().studioHistoryLimits).filter(([key]) => !key.startsWith(executionPrefix)));
      set({ studioExecutions: executions, studioSubmitting: submitting, studioHistoryLimits: historyLimits,
        ...(removingSelected ? { studioStage: 'story' as const } : {}) });
      return true;
    },
    addStudioEpisode: (name) => {
      const d = get().studioDraft;
      if (!d.projectId || d.projects.find(p => p.id === d.projectId)?.contentMode === 'ad') return;
      const episode: StudioEpisode = { id: crypto.randomUUID(), name: name.trim().slice(0, 100) || 'EP', script: '', agentBrief: '', shots: [] };
      change({ ...d, episodeId: episode.id, projects: d.projects.map(p => p.id === d.projectId
        ? { ...p, updatedAt: Date.now(), episodes: [...p.episodes, episode] } : p) });
      set({ studioStage: 'story' });
    },
    selectStudioEpisode: (id) => {
      const d = get().studioDraft;
      if (d.projects.find(p => p.id === d.projectId)?.episodes.some(e => e.id === id)) change({ ...d, episodeId: id });
    },
    editStudioEpisode: (id, patch) => {
      const d = get().studioDraft;
      change({ ...d, projects: d.projects.map(p => p.id === d.projectId
        ? { ...p, updatedAt: Date.now(), episodes: p.episodes.map(e => e.id === id
          ? { ...e, ...patch, ...(patch.models ? { models: { ...e.models, ...patch.models } } : {}) }
          : e) } : p) });
    },
  };
};
