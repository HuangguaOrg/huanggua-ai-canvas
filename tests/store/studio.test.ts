import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { create, type StateCreator } from 'zustand';
import { createStudioSlice, type StudioSlice } from '../../src/store/store.studio';
import * as repository from '../../src/services/studioDraftRepository';
const makeStore = () => create<StudioSlice>()(createStudioSlice as unknown as StateCreator<StudioSlice>);
beforeEach(() => { vi.restoreAllMocks(); vi.stubGlobal('indexedDB', new IDBFactory()); });
describe('local short drama authoring drafts', () => {
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
