import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { create, type StateCreator } from 'zustand';
import { createStudioSlice, type StudioSlice } from '../../src/store/store.studio';
import * as repository from '../../src/services/studioDraftRepository';
import type { AppState } from '../../src/store/useAppStore';
import { studioWorkspace } from '../../src/services/studioWorkspaceService';
vi.mock('../../src/services/studioWorkspaceService', () => ({ studioWorkspace: vi.fn() }));
type TestState = StudioSlice & Pick<AppState, 'studioExecutions' | 'studioSubmitting' | 'studioHistoryLimits'>;
const makeStore = () => create<TestState>()((...args) => ({
  ...(createStudioSlice as unknown as StateCreator<TestState>)(...args),
  studioExecutions: {}, studioSubmitting: {}, studioHistoryLimits: {},
}));
beforeEach(() => { vi.restoreAllMocks(); vi.mocked(studioWorkspace).mockReset().mockResolvedValue({ ok: true }); vi.stubGlobal('indexedDB', new IDBFactory()); });
describe('local short drama authoring drafts', () => {
  it('repairs and persists an old preference when the account catalog is ready before the draft loads', async () => {
    const store = makeStore();
    await store.getState().loadStudio();
    const { episodeId } = store.getState().createStudioProject('旧分集')!;
    store.getState().editStudioEpisode(episodeId, { models: { image: 'existing-image' } });
    store.getState().editStudioEpisode(episodeId, {
      models: { video: 'grsai-agnes-video-2.5-720p' },
      shots: [{ id: 'shot-1', title: '开场', description: '远景', duration: 4 }],
    });
    await store.getState().saveStudio();
    const reopened = create<AppState>()((...args) => ({
      ...createStudioSlice(...args), studioConnection: 'ready',
      studioModels: { text: ['text'], image: ['existing-image'] },
      studioVideoModelsByMode: { storyboard: ['other', 'hg-video-agnes-2.5'] },
    } as AppState));
    await reopened.getState().loadStudio();
    const draft = await repository.readStudioDrafts();
    expect(draft.projects[0].episodes[0]).toEqual({
      ...store.getState().studioDraft.projects[0].episodes[0],
      models: { image: 'existing-image', video: 'hg-video-agnes-2.5' },
    });
    expect(reopened.getState().studioDraft).toEqual(draft);
  });
  it('deletes only the chosen project, preserves the selected episode and persists across reopen', async () => {
    const store = makeStore(); await store.getState().loadStudio();
    const removed = store.getState().createStudioProject('删除此项目')!;
    const kept = store.getState().createStudioProject('保留此项目')!;
    store.getState().addStudioEpisode('第二集');
    const selected = store.getState().studioDraft.episodeId;
    const removedKey = `${removed.projectId}/${removed.episodeId}`;
    const keptKey = `${kept.projectId}/${kept.episodeId}`;
    store.setState({ studioHistoryLimits: { [removedKey]: 200, [keptKey]: 300 } });
    await store.getState().deleteStudioProject(removed.projectId);
    expect(studioWorkspace).toHaveBeenCalledWith(removed, 'project_delete');
    expect(store.getState().studioHistoryLimits).toEqual({ [keptKey]: 300 });
    const reopened = makeStore(); await reopened.getState().loadStudio();
    expect(reopened.getState().studioDraft).toMatchObject({ projectId: kept.projectId, episodeId: selected });
    expect(reopened.getState().studioDraft.projects.map(p => p.id)).toEqual([kept.projectId]);
  });
  it('selects another project after deleting the current one and clears selection after deleting the last', async () => {
    const store = makeStore(); await store.getState().loadStudio();
    const first = store.getState().createStudioProject('第一部')!;
    const second = store.getState().createStudioProject('第二部')!;
    await store.getState().deleteStudioProject(second.projectId);
    expect(store.getState().studioDraft).toMatchObject(first);
    await store.getState().deleteStudioProject(first.projectId);
    expect(await repository.readStudioDrafts()).toEqual({ version: 1, projects: [], projectId: null, episodeId: null });
  });
  it('retains drafts after a runtime rejection or persistence failure and allows deletion to retry', async () => {
    const store = makeStore(); await store.getState().loadStudio();
    const project = store.getState().createStudioProject('可重试')!;
    await store.getState().saveStudio();
    const draft = store.getState().studioDraft;
    vi.mocked(studioWorkspace).mockRejectedValueOnce('studio_engine_rejected');
    await expect(store.getState().deleteStudioProject(project.projectId)).rejects.toBe('studio_engine_rejected');
    expect(store.getState().studioDraft).toEqual(draft);
    vi.spyOn(repository, 'writeStudioDrafts').mockRejectedValueOnce(new Error('quota'));
    await expect(store.getState().deleteStudioProject(project.projectId)).rejects.toBe('studio_save_failed');
    expect(store.getState().studioDraft).toEqual(draft);
    expect(await repository.readStudioDrafts()).toEqual(draft);
    await store.getState().deleteStudioProject(project.projectId);
    expect((await repository.readStudioDrafts()).projects).toEqual([]);
  });
  it('preserves edits and new projects made while runtime deletion is pending', async () => {
    const store = makeStore(); await store.getState().loadStudio();
    const removed = store.getState().createStudioProject('删除此项目')!;
    const kept = store.getState().createStudioProject('保留此项目')!;
    let resolveDelete!: (value: unknown) => void;
    vi.mocked(studioWorkspace).mockReturnValueOnce(new Promise(resolve => { resolveDelete = resolve; }));
    const pending = store.getState().deleteStudioProject(removed.projectId);
    store.getState().editStudioEpisode(kept.episodeId, { script: '请求期间的新内容' });
    const created = store.getState().createStudioProject('新项目')!;
    resolveDelete({ ok: true });
    await pending;
    const saved = await repository.readStudioDrafts();
    expect(saved.projects.map(p => p.id)).toEqual([kept.projectId, created.projectId]);
    expect(saved.projects[0].episodes[0].script).toBe('请求期间的新内容');
    expect(saved.projectId).toBe(created.projectId);
  });
  it('persists ad/reference mode and prevents adding an ad episode', async () => {
    const store = makeStore(); await store.getState().loadStudio();
    store.getState().createStudioProject('广告测试', 'ad', 'reference_video');
    store.getState().addStudioEpisode('不应新增');
    await store.getState().saveStudio();
    const reopened = makeStore(); await reopened.getState().loadStudio();
    const project = reopened.getState().studioDraft.projects[0];
    expect(project.contentMode).toBe('ad');
    expect(project.generationMode).toBe('reference_video');
    expect(project.episodes).toHaveLength(1);
  });
  it('reopens projects, scripts and shots without touching canvas projects', async () => {
    const store = makeStore(); await store.getState().loadStudio();
    store.getState().createStudioProject('测试短剧');
    const id = store.getState().studioDraft.episodeId!;
    store.getState().editStudioEpisode(id, { script: '雨夜，女孩走进旧书店。', shots: [{ id: 'shot-1', title: '开场', description: '街道远景', duration: 5 }] });
    await store.getState().saveStudio();
    const reopened = makeStore(); await reopened.getState().loadStudio();
    expect(reopened.getState().studioDraft).toEqual(store.getState().studioDraft);
  });
  it('keeps episode edits isolated and retains the last selection', async () => {
    const store = makeStore(); await store.getState().loadStudio();
    store.getState().createStudioProject('测试短剧');
    const first = store.getState().studioDraft.episodeId!;
    store.getState().editStudioEpisode(first, { script: '第一集', models: { video: 'grsai-wan-3.0-480p' } });
    store.getState().addStudioEpisode('第二集');
    const second = store.getState().studioDraft.episodeId!;
    store.getState().editStudioEpisode(second, { script: '第二集', agentBrief: '保持一致' });
    store.getState().selectStudioEpisode(first);
    await store.getState().saveStudio();
    const saved = await repository.readStudioDrafts();
    expect(saved.episodeId).toBe(first);
    expect(saved.projects[0].episodes.map(e => e.script)).toEqual(['第一集', '第二集']);
    const reopened = makeStore(); await reopened.getState().loadStudio();
    expect(reopened.getState().studioDraft.projects[0].episodes[0].models).toEqual({ video: 'grsai-wan-3.0-480p' });
    expect(reopened.getState().studioDraft.projects[0].episodes[1].models).toBeUndefined();
  });
  it('serializes rapid edits so an earlier save cannot replace the latest text', async () => {
    const store = makeStore(); await store.getState().loadStudio();
    store.getState().createStudioProject('测试短剧');
    const id = store.getState().studioDraft.episodeId!;
    for (let i = 0; i < 20; i++) store.getState().editStudioEpisode(id, { script: String(i) });
    await store.getState().saveStudio();
    expect((await repository.readStudioDrafts()).projects[0].episodes[0].script).toBe('19');
    expect(store.getState().studioSave).toBe('saved');
  });
  it('does not overwrite storage after a failed load', async () => {
    vi.spyOn(repository, 'readStudioDrafts').mockRejectedValueOnce(new Error('corrupt'));
    const write = vi.spyOn(repository, 'writeStudioDrafts');
    const store = makeStore(); await store.getState().loadStudio();
    store.getState().createStudioProject('不可写入');
    await store.getState().saveStudio();
    expect(store.getState().studioLoad).toBe('error');
    expect(write).not.toHaveBeenCalled();
  });
  it('retains edits on save failure and permits a successful retry', async () => {
    const store = makeStore(); await store.getState().loadStudio();
    store.getState().createStudioProject('测试短剧'); await store.getState().saveStudio();
    vi.spyOn(repository, 'writeStudioDrafts').mockRejectedValueOnce(new Error('quota'));
    await store.getState().saveStudio();
    expect(store.getState().studioSave).toBe('error');
    expect(store.getState().studioDraft.projects).toHaveLength(1);
    await store.getState().saveStudio();
    expect(store.getState().studioSave).toBe('saved');
  });
});
