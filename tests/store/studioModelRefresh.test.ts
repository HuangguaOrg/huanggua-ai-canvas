import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type { AppState } from '../../src/store/useAppStore';
vi.mock('../../src/services/studioExecutionService', () => ({ studioError: String, studioRequest: vi.fn(), submitStudio: vi.fn(), pollStudioExecutions: vi.fn() }));
import { studioRequest } from '../../src/services/studioExecutionService';
import { createStudioExecutionSlice } from '../../src/store/store.studioExecution';
const request = vi.mocked(studioRequest);
const videoSpecs = { h3: { id: 'h3', display_name: 'H3', spec_status: 'available' as const, default_resolution: '768p', seconds_by_resolution: { '768p': [3, 4] } } };
const latest = { videoSpecs, models: { image: ['new'] }, videoModelsByMode: { storyboard: ['frame'], reference_video: ['reference'] } };
const makeStore = () => create<AppState>()((...args) => ({ ...createStudioExecutionSlice(...args) } as AppState));
beforeEach(() => vi.resetAllMocks());
describe('studio catalog refresh', () => {
  it('migrates only saved model preferences using the current account and production mode', async () => {
    const store = makeStore();
    const old = 'grsai-agnes-video-2.5-720p';
    const merged = 'hg-video-agnes-2.5';
    const image = 'hg-image-nano-banana-2.1';
    const catalog = {
      models: { text: ['text'], image: ['other', image] },
      videoModelsByMode: { storyboard: ['first', merged], reference_video: ['ref-first'] },
    };
    const submission = { requestId: 'pending', content: 'plan', models: { video: old } };
    const episode = {
      id: 'ep', name: 'E', script: '原分镜', agentBrief: '草稿', nativeVideoResolution: '720p',
      shots: [{ id: 'shot-1', title: '开场', description: '街道', duration: 4 }],
      models: { text: 'text', video: old, image: 'grsai-nano-banana-2.1' }, submission,
    };
    const project = { id: 'p', name: 'P', updatedAt: 1, episodes: [episode] };
    const draft: AppState['studioDraft'] = {
      version: 1, projectId: 'p', episodeId: 'ep',
      projects: [
        project, { ...project, id: 'ref', generationMode: 'reference_video' },
        { ...project, id: 'ordinary', episodes: [{ ...episode, models: { video: 'first' } }] },
      ],
    };
    const saveStudio = vi.fn(async () => {});
    store.setState({ studioDraft: draft, studioLoad: 'ready', studioConnection: 'ready', saveStudio });
    request.mockResolvedValue(catalog);
    await store.getState().refreshStudioModels();
    const repaired = store.getState().studioDraft;
    expect(repaired.projects[0].episodes[0]).toEqual({ ...episode, models: { text: 'text', video: merged, image } });
    expect(repaired.projects[0].episodes[0].submission).toBe(submission);
    expect(repaired.projects[0].episodes[0].shots).toBe(episode.shots);
    expect(repaired.projects[1].episodes[0].models?.video).toBe('ref-first');
    expect(repaired.projects[2]).toBe(draft.projects[2]);
    await store.getState().refreshStudioModels();
    request.mockResolvedValue({ models: { text: ['text'] }, videoModelsByMode: {} });
    await store.getState().refreshStudioModels();
    expect(store.getState().studioDraft).toBe(repaired);
    expect(saveStudio).toHaveBeenCalledTimes(1);
  });
  it('replaces both catalogs without changing the execution epoch or submission flags', async () => {
    const store = makeStore();
    store.setState({ studioConnection: 'ready', studioEpoch: 4, studioModels: { image: ['old'] }, studioSubmitting: { running: true } });
    const executions = store.getState().studioExecutions;
    request.mockResolvedValueOnce(latest);
    await store.getState().refreshStudioModels();
    expect(request).toHaveBeenCalledWith('status');
    expect(store.getState()).toMatchObject({ studioEpoch: 4, studioConnection: 'ready', studioModels: latest.models, studioVideoModelsByMode: latest.videoModelsByMode, studioVideoSpecs: videoSpecs, studioSubmitting: { running: true }, studioModelsRefreshing: false });
    expect(store.getState().studioExecutions).toBe(executions);
  });
  it('preserves the previous list and reports a failure for retry', async () => {
    const store = makeStore(); store.setState({ studioConnection: 'ready', studioModels: { image: ['old'] } });
    request.mockRejectedValueOnce('studio_connection_lost');
    await store.getState().refreshStudioModels();
    expect(store.getState()).toMatchObject({ studioModels: { image: ['old'] }, studioModelRefreshError: 'studio_connection_lost', studioModelsRefreshing: false });
    request.mockResolvedValueOnce(latest); await store.getState().refreshStudioModels();
    expect(store.getState().studioModelRefreshError).toBeNull();
    expect(store.getState().studioModels).toEqual(latest.models);
  });
  it('ignores duplicate requests and late results after logout', async () => {
    const store = makeStore(); store.setState({ studioConnection: 'ready', studioVideoSpecs: videoSpecs });
    let resolve!: (value: typeof latest) => void;
    request.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const refreshing = store.getState().refreshStudioModels();
    await store.getState().refreshStudioModels(); expect(request).toHaveBeenCalledTimes(1);
    await store.getState().disconnectStudio(); resolve(latest); await refreshing;
    expect(store.getState()).toMatchObject({ studioConnection: 'idle', studioModels: {}, studioVideoSpecs: {}, studioModelsRefreshing: false });
  });
  it('waits for an initial connection, then fetches again rather than accepting its older catalog', async () => {
    const store = makeStore(); store.setState({ studioConnection: 'connecting' });
    const refreshing = store.getState().refreshStudioModels();
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValueOnce(latest);
    store.setState({ studioConnection: 'ready', studioModels: { image: ['old'] } });
    await refreshing;
    expect(store.getState().studioModels).toEqual(latest.models);
  });
  it('does not start an unused studio when refreshing canvas models', async () => {
    await makeStore().getState().refreshStudioModels(); expect(request).not.toHaveBeenCalled();
  });
});
