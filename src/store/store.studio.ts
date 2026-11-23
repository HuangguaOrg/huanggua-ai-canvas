import type { StateCreator } from 'zustand';
import type { AppState } from './useAppStore';
import type { StudioDraftDocument, StudioEpisode, StudioStage } from '../types/studio';
import { readStudioDrafts, writeStudioDrafts } from '../services/studioDraftRepository';

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
  addStudioEpisode: (name: string) => void;
  selectStudioEpisode: (id: string) => void;
  editStudioEpisode: (id: string, patch: Partial<Pick<StudioEpisode, 'name' | 'script' | 'agentBrief' | 'shots' | 'models' | 'rewriteAnchor'>>) => void;
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
      try { set({ studioDraft: await readStudioDrafts(), studioLoad: 'ready' }); }
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
        ? { ...p, updatedAt: Date.now(), episodes: p.episodes.map(e => e.id === id ? { ...e, ...patch } : e) } : p) });
    },
  };
};
