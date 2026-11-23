import { beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareAppUpdate } from '../../src/services/appUpdateReadiness';
const mocks = vi.hoisted(() => ({ getState: vi.fn(), prepare: vi.fn(), resume: vi.fn() }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: mocks.getState } }));
vi.mock('../../src/services/configPersistenceQueue', () => ({ prepareSettingsClose: mocks.prepare, resumeSettingsPersistence: mocks.resume }));
const state = {
  nodes: [] as Array<{ data: { status: string } }>, agentTasks: [], studioSubmitting: {}, studioExecutions: {},
  studioConnection: 'ready', studioDraft: { projects: [] }, studioSave: 'saved', currentProjectId: 'canvas', autoSaveFailure: false,
  saveStudio: vi.fn(), saveCurrentProjectSilent: vi.fn(),
};
beforeEach(() => {
  vi.resetAllMocks(); state.nodes = []; state.studioSave = 'saved';
  mocks.getState.mockReturnValue(state); mocks.prepare.mockResolvedValue(true);
  state.saveCurrentProjectSilent.mockResolvedValue('canvas');
});
describe('update readiness', () => {
  it('rejects running generation before freezing settings or saving', async () => {
    state.nodes = [{ data: { status: 'loading' } }];
    await expect(prepareAppUpdate()).rejects.toThrow('当前生成任务');
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it('persists both workspaces before allowing restart', async () => {
    const release = await prepareAppUpdate();
    expect(state.saveStudio).toHaveBeenCalledOnce();
    expect(state.saveCurrentProjectSilent).toHaveBeenCalledOnce();
    expect(mocks.resume).not.toHaveBeenCalled(); release();
    expect(mocks.resume).toHaveBeenCalledOnce();
  });
  it('unfreezes settings and rejects a failed short drama save', async () => {
    state.saveStudio.mockImplementation(async () => { state.studioSave = 'error'; });
    await expect(prepareAppUpdate()).rejects.toThrow('短剧草稿保存失败');
    expect(state.saveCurrentProjectSilent).not.toHaveBeenCalled();
    expect(mocks.resume).toHaveBeenCalledOnce();
  });
});
