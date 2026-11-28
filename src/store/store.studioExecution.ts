import type { StateCreator, StoreApi } from 'zustand';
import type { AppState } from './useAppStore';
import type { StudioAttachment, StudioEpisode, StudioExecution, StudioVideoSpec } from '../types/studio';
import { studioError, studioRequest, submitStudio, pollStudioExecutions } from '../services/studioExecutionService';
import { reconcileStudioDraftModels } from '../services/studioModelSelection';

interface StudioCatalogStatus {
  models: Record<string, string[]>;
  videoModelsByMode?: StudioExecutionSlice['studioVideoModelsByMode'];
  videoSpecs?: Record<string, StudioVideoSpec>;
}

function applyStudioCatalog(store: StoreApi<AppState>, result: StudioCatalogStatus) {
  const state = store.getState();
  const byMode = result.videoModelsByMode ?? {};
  const draft = state.studioLoad === 'ready'
    ? reconcileStudioDraftModels(state.studioDraft, result.models, byMode) : state.studioDraft;
  store.setState({
    studioConnection: 'ready', studioModels: result.models, studioVideoModelsByMode: byMode,
    studioVideoSpecs: result.videoSpecs ?? {}, ...(draft !== state.studioDraft ? { studioDraft: draft } : {}),
  });
  if (draft !== state.studioDraft) void store.getState().saveStudio();
}

export interface StudioExecutionSlice {
  studioVideoSpecs: Record<string, StudioVideoSpec>;
  studioConnection: 'idle' | 'connecting' | 'ready' | 'error';
  studioEpoch: number;
  studioConnectionError: string | null;
  studioModels: Record<string, string[]>;
  studioModelsRefreshing: boolean;
  studioModelRefreshError: string | null;
  refreshStudioModels: () => Promise<void>;
  studioVideoModelsByMode: Partial<Record<'storyboard' | 'reference_video', string[]>>;
  studioExecutions: Record<string, StudioExecution>;
  studioSubmitting: Record<string, boolean>;
  studioHistoryLimits: Record<string, number>;
  loadMoreStudioHistory: (key: string) => void;
  connectStudio: () => Promise<void>;
  updateStudioExecution: (key: string, execution: StudioExecution) => void;
  setStudioSubmission: (projectId: string, episodeId: string, submission: StudioEpisode['submission']) => void;
  setStudioAttachments: (projectId: string, episodeId: string, attachments: StudioAttachment[]) => void;
  restoreStudioMessage: (projectId: string, episodeId: string, text: string, attachments: StudioAttachment[]) => void;
  acknowledgeStudioSubmission: (projectId: string, episodeId: string, requestId: string, brief?: string) => void;
  runStudio: (models: Record<string, string>, retry?: boolean) => Promise<void>;
  controlStudio: (operation: 'interrupt' | 'answer' | 'cancel_task', payload?: Record<string, unknown>) => Promise<void>;
  disconnectStudio: () => Promise<void>;
}
export const createStudioExecutionSlice: StateCreator<AppState, [], [], StudioExecutionSlice> = (set, get, store) => ({
  studioConnection: 'idle', studioEpoch: 0, studioConnectionError: null, studioModels: {}, studioVideoModelsByMode: {}, studioVideoSpecs: {}, studioExecutions: {}, studioSubmitting: {}, studioHistoryLimits: {},
  studioModelsRefreshing: false, studioModelRefreshError: null,
  loadMoreStudioHistory: key => { set(s => ({ studioHistoryLimits: { ...s.studioHistoryLimits, [key]: Math.min(1000, (s.studioHistoryLimits[key] ?? 100) + 100) } })); void pollStudioExecutions(); },
  connectStudio: async () => {
    if (get().studioConnection === 'connecting') return;
    const epoch = get().studioEpoch + 1;
    set({ studioEpoch: epoch });
    set({ studioConnection: 'connecting', studioConnectionError: null, studioModelsRefreshing: false, studioModelRefreshError: null });
    try {
      const result = await studioRequest<StudioCatalogStatus>('status');
      if (get().studioEpoch !== epoch) return;
      applyStudioCatalog(store, result);
      await pollStudioExecutions();
    } catch (error) { if (get().studioEpoch === epoch) set({ studioConnection: 'error', studioConnectionError: studioError(error) }); }
  },
  refreshStudioModels: async () => {
    // Never reconnect or advance the epoch of an active session just to update its catalog.
    if (get().studioConnection === 'idle' || get().studioModelsRefreshing) return;
    if (get().studioConnection === 'connecting') {
      await new Promise<void>(resolve => {
        const unsubscribe = store.subscribe(state => {
          if (state.studioConnection !== 'connecting') { unsubscribe(); resolve(); }
        });
      });
      return get().refreshStudioModels();
    }
    if (get().studioConnection === 'error') {
      const epoch = get().studioEpoch + 1;
      await get().connectStudio();
      if (get().studioEpoch === epoch) set({ studioModelRefreshError: get().studioConnectionError });
      return;
    }
    const epoch = get().studioEpoch;
    set({ studioModelsRefreshing: true, studioModelRefreshError: null });
    try {
      const result = await studioRequest<StudioCatalogStatus>('status');
      if (get().studioEpoch !== epoch) return;
      applyStudioCatalog(store, result);
    } catch (error) {
      if (get().studioEpoch === epoch) set({ studioModelRefreshError: studioError(error) });
    } finally {
      if (get().studioEpoch === epoch) set({ studioModelsRefreshing: false });
    }
  },
  disconnectStudio: async () => {
    set({ studioModelsRefreshing: false, studioModelRefreshError: null, studioConnection: 'idle', studioEpoch: get().studioEpoch + 1, studioModels: {}, studioVideoModelsByMode: {}, studioVideoSpecs: {}, studioExecutions: {}, studioSubmitting: {} });
    try { await studioRequest('shutdown'); } catch { /* unavailable on browser preview */ }
  },
  updateStudioExecution: (key, execution) => set(s => ({ studioExecutions: { ...s.studioExecutions, [key]: execution } })),
  setStudioAttachments: (projectId, episodeId, attachments) => {
    set(s => ({ studioDraft: { ...s.studioDraft, projects: s.studioDraft.projects.map(p => p.id === projectId
      ? { ...p, episodes: p.episodes.map(e => e.id === episodeId ? { ...e, attachments } : e) } : p) } }));
    void get().saveStudio();
  },
  restoreStudioMessage: (projectId, episodeId, text, attachments) => {
    set(s => ({ studioDraft: { ...s.studioDraft, projects: s.studioDraft.projects.map(p => p.id === projectId
      ? { ...p, episodes: p.episodes.map(e => e.id === episodeId ? { ...e,
        agentBrief: [e.agentBrief, text].filter(Boolean).join('\n\n'),
        attachments: [...(e.attachments ?? []), ...attachments].filter((a, i, all) => all.findIndex(b => b.id === a.id) === i),
      } : e) } : p) } }));
    void get().saveStudio();
  },
  setStudioSubmission: (projectId, episodeId, submission) => {
    set(s => ({ studioDraft: { ...s.studioDraft, projects: s.studioDraft.projects.map(p => p.id === projectId
      ? { ...p, episodes: p.episodes.map(e => e.id === episodeId ? { ...e, submission } : e) } : p) } }));
    void get().saveStudio();
  },
  acknowledgeStudioSubmission: (projectId, episodeId, requestId, brief) => {
    set(s => ({ studioDraft: { ...s.studioDraft, projects: s.studioDraft.projects.map(p => p.id === projectId
      ? { ...p, episodes: p.episodes.map(e => e.id === episodeId && e.submission?.requestId === requestId
        ? { ...e, submission: undefined, agentBrief: brief !== undefined && e.agentBrief === brief ? '' : e.agentBrief,
          attachments: e.attachments?.filter(a => !e.submission?.attachments?.some(sent => sent.id === a.id)),
          rewriteAnchor: e.rewriteAnchor === e.submission.rewriteAnchor ? undefined : e.rewriteAnchor } : e) } : p) } }));
    void get().saveStudio();
  },
  runStudio: async (models, retry) => {
    const epoch = get().studioEpoch;
    const { projectId, episodeId } = get().studioDraft;
    if (!projectId || !episodeId) return;
    const key = `${projectId}/${episodeId}`;
    if (get().studioSubmitting[key]) return;
    set(s => ({ studioSubmitting: { ...s.studioSubmitting, [key]: true }, studioConnectionError: null }));
    try { await submitStudio(projectId, episodeId, models, retry); }
    catch (error) { if (get().studioEpoch === epoch) set({ studioConnectionError: studioError(error) }); }
    finally { if (get().studioEpoch === epoch) set(s => ({ studioSubmitting: { ...s.studioSubmitting, [key]: false } })); }
  },
  controlStudio: async (operation, payload = {}) => {
    const epoch = get().studioEpoch;
    const { projectId, episodeId } = get().studioDraft;
    try { await studioRequest(operation, { projectId, episodeId, ...payload }); await pollStudioExecutions(); }
    catch (error) { if (get().studioEpoch === epoch) set({ studioConnectionError: studioError(error) }); }
  },
});
