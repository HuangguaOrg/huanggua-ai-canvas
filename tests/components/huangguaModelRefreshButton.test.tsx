import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  account: { busy: false, hasSession: true, phase: 'connected', error: null as string | null, refresh: vi.fn(), setDialogOpen: vi.fn() },
  app: { studioModelsRefreshing: false, studioModelRefreshError: null as string | null, showToast: vi.fn() },
}));
vi.mock('../../src/i18n', () => ({ useT: () => (text: string) => text }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: Object.assign((selector: (state: typeof mock.app) => unknown) => selector(mock.app), { getState: () => mock.app }) }));
vi.mock('../../src/store/useHuangguaAccountStore', () => ({ useHuangguaAccountStore: Object.assign((selector: (state: typeof mock.account) => unknown) => selector(mock.account), { getState: () => mock.account }) }));
import HuangguaModelRefreshButton from '../../src/components/account/HuangguaModelRefreshButton';
beforeEach(() => {
  vi.resetAllMocks(); Object.assign(mock.account, { busy: false, hasSession: true, phase: 'connected', error: null });
  Object.assign(mock.app, { studioModelsRefreshing: false, studioModelRefreshError: null });
  mock.account.refresh.mockResolvedValue(undefined);
});
describe('shared model refresh button', () => {
  it('refreshes the account catalog and reports completion', async () => {
    HuangguaModelRefreshButton().props.onClick();
    await vi.waitFor(() => expect(mock.app.showToast).toHaveBeenCalledWith('模型列表已更新', 'success'));
    expect(mock.account.refresh).toHaveBeenCalledTimes(1);
  });
  it('opens login without issuing an unauthenticated request', () => {
    mock.account.hasSession = false; HuangguaModelRefreshButton().props.onClick();
    expect(mock.account.setDialogOpen).toHaveBeenCalledWith(true);
    expect(mock.account.refresh).not.toHaveBeenCalled();
  });
  it('disables repeated clicks while either workspace is refreshing', () => {
    mock.account.busy = true;
    expect(HuangguaModelRefreshButton().props.disabled).toBe(true);
    HuangguaModelRefreshButton().props.onClick();
    mock.account.busy = false; mock.app.studioModelsRefreshing = true;
    expect(HuangguaModelRefreshButton().props.disabled).toBe(true);
    HuangguaModelRefreshButton().props.onClick();
    expect(mock.account.refresh).not.toHaveBeenCalled();
  });
  it('shows the account error instead of claiming success', async () => {
    mock.account.refresh.mockImplementation(async () => { mock.account.error = 'network'; });
    HuangguaModelRefreshButton().props.onClick();
    await vi.waitFor(() => expect(mock.account.setDialogOpen).toHaveBeenCalledWith(true));
    expect(mock.app.showToast).toHaveBeenCalledWith('模型列表更新失败，请在账号窗口查看原因并重试。', 'error');
  });
  it('reports a partial studio failure and permits retry', async () => {
    mock.app.studioModelRefreshError = 'studio_connection_lost';
    HuangguaModelRefreshButton().props.onClick();
    await vi.waitFor(() => expect(mock.app.showToast).toHaveBeenCalledWith('画布模型已更新，短剧模型刷新失败，请重试。', 'error'));
    expect(HuangguaModelRefreshButton().props.disabled).toBe(false);
  });
});
