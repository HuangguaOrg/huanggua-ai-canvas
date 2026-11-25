import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';
import type { AppState } from '../../src/store/useAppStore';
vi.mock('../../src/services/studioExecutionService', () => ({ studioError: String, studioRequest: vi.fn(), submitStudio: vi.fn(), pollStudioExecutions: vi.fn() }));
import { studioRequest } from '../../src/services/studioExecutionService';
import { createStudioExecutionSlice } from '../../src/store/store.studioExecution';
const request = vi.mocked(studioRequest);
const latest = { models: { image: ['new'] }, videoModelsByMode: { storyboard: ['frame'], reference_video: ['reference'] } };
const makeStore = () => create<AppState>()((...args) => ({ ...createStudioExecutionSlice(...args) } as AppState));
beforeEach(() => vi.resetAllMocks());
describe('studio catalog refresh', () => {
  it('replaces both catalogs without changing the execution epoch or submission flags', async () => {
    const store = makeStore();
    store.setState({ studioConnection: 'ready', studioEpoch: 4, studioModels: { image: ['old'] }, studioSubmitting: { running: true } });
    const executions = store.getState().studioExecutions;
    request.mockResolvedValueOnce(latest);
    await store.getState().refreshStudioModels();
    expect(request).toHaveBeenCalledWith('status');
    expect(store.getState()).toMatchObject({ studioEpoch: 4, studioConnection: 'ready', studioModels: latest.models, studioVideoModelsByMode: latest.videoModelsByMode, studioSubmitting: { running: true }, studioModelsRefreshing: false });
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
    const store = makeStore(); store.setState({ studioConnection: 'ready' });
    let resolve!: (value: typeof latest) => void;
    request.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const refreshing = store.getState().refreshStudioModels();
    await store.getState().refreshStudioModels(); expect(request).toHaveBeenCalledTimes(1);
    await store.getState().disconnectStudio(); resolve(latest); await refreshing;
    expect(store.getState()).toMatchObject({ studioConnection: 'idle', studioModels: {}, studioModelsRefreshing: false });
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
