import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHuangguaAccountStore } from '../../src/store/useHuangguaAccountStore';
import { HuangguaAuthError } from '../../src/services/huangguaAccountService';
const mock = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), clear: vi.fn(), login: vi.fn(), verify: vi.fn(), authorize: vi.fn(), account: vi.fn(), revoke: vi.fn(), close: vi.fn(), sync: vi.fn(), clearModels: vi.fn() }));
vi.mock('../../src/services/huangguaAccountService', async (original) => ({
  ...await original<typeof import('../../src/services/huangguaAccountService')>(),
  createSessionSecret: () => 'fixture-session-secret', loadHuangguaSession: mock.load, saveHuangguaSession: mock.save,
  clearHuangguaSession: mock.clear, authenticateHuanggua: mock.login, verifyHuangguaLogin: mock.verify,
  authorizeHuangguaDesktop: mock.authorize, readHuangguaAccount: mock.account, revokeHuangguaSession: mock.revoke,
  closeHuangguaDashboardSession: mock.close,
}));
vi.mock('../../src/services/huangguaModelConnectionService', () => ({ syncHuangguaModels: mock.sync, clearHuangguaModels: mock.clearModels }));
const snapshot = () => ({ account: { id: 1, name: '测试账号', username: 'fixture', balance: '¥2.00', expiresAt: Date.now() + 3600000 }, connections: [{ category: 'text', apiKey: 'fixture-model-key', models: ['gpt-fixture'] }] });
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks(); mock.load.mockResolvedValue(null);
  mock.login.mockResolvedValue({ kind: 'authenticated', accessToken: 'fixture-dashboard-token' });
  mock.account.mockResolvedValue(snapshot()); mock.sync.mockResolvedValue({ text: 1, image: 0, video: 0 });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('Huanggua account and automatic model lifecycle', () => {
  it('initializes once and does not log in without user input', async () => {
    const store = createHuangguaAccountStore(); await Promise.all([store.getState().initialize(), store.getState().initialize()]);
    expect(mock.load).toHaveBeenCalledTimes(1); expect(mock.login).not.toHaveBeenCalled(); expect(store.getState().dialogOpen).toBe(true);
  });
  it('connects models after login and closes the temporary dashboard session', async () => {
    const store = createHuangguaAccountStore(); await store.getState().startLogin('fixture', 'fixture-password');
    expect(store.getState().phase).toBe('connected'); expect(store.getState().modelCounts.text).toBe(1);
    expect(mock.save.mock.invocationCallOrder[0]).toBeLessThan(mock.authorize.mock.invocationCallOrder[0]);
    expect(mock.close).toHaveBeenCalledWith('fixture-dashboard-token');
    expect(JSON.stringify(store.getState())).not.toMatch(/fixture-(password|session-secret|model-key|dashboard-token)/);
  });
  it('does not create grants until second-factor verification succeeds', async () => {
    mock.login.mockResolvedValue({ kind: 'verification', flowToken: 'fixture-flow', expiresAt: Date.now() + 300000 });
    const store = createHuangguaAccountStore(); await store.getState().startLogin('fixture', 'password');
    expect(store.getState().phase).toBe('verification'); expect(mock.authorize).not.toHaveBeenCalled();
    expect(JSON.stringify(store.getState())).not.toContain('fixture-flow');
    mock.verify.mockRejectedValueOnce(new HuangguaAuthError('invalid_code'));
    await store.getState().verifyLogin('000000'); expect(store.getState().phase).toBe('verification');
    mock.verify.mockResolvedValueOnce('fixture-dashboard-token'); await store.getState().verifyLogin('123456');
    expect(store.getState().phase).toBe('connected');
  });
  it('does not authorize when secret persistence fails and still revokes temporary login', async () => {
    mock.save.mockRejectedValue(new HuangguaAuthError('storage'));
    const store = createHuangguaAccountStore(); await store.getState().startLogin('fixture', 'password');
    expect(mock.authorize).not.toHaveBeenCalled(); expect(mock.close).toHaveBeenCalledTimes(1); expect(store.getState().phase).toBe('error');
  });
  it('removes model access before attempting remote logout, even when revocation fails', async () => {
    mock.load.mockResolvedValue('fixture-session-secret'); const store = createHuangguaAccountStore(); await store.getState().initialize();
    mock.clearModels.mockClear(); mock.revoke.mockRejectedValue(new HuangguaAuthError('network'));
    await store.getState().logout();
    expect(mock.clearModels.mock.invocationCallOrder[0]).toBeLessThan(mock.revoke.mock.invocationCallOrder[0]);
    expect(store.getState().hasSession).toBe(true); expect(store.getState().account).toBeNull(); expect(mock.clear).not.toHaveBeenCalled();
  });
  it('restores models from a fresh account response and removes them on expiry', async () => {
    mock.load.mockResolvedValue('fixture-session-secret'); const store = createHuangguaAccountStore(); await store.getState().initialize();
    expect(mock.sync).toHaveBeenCalledTimes(1);
    mock.account.mockRejectedValueOnce(new HuangguaAuthError('invalid_session'));
    await vi.advanceTimersByTimeAsync(60000);
    expect(store.getState().account).toBeNull(); expect(store.getState().hasSession).toBe(false); expect(mock.clear).toHaveBeenCalled();
  });
  it('revokes stale legacy sessions on startup and opens the login dialog for re-authentication', async () => {
    mock.load.mockResolvedValue('fixture-legacy-session');
    mock.account.mockRejectedValueOnce(new HuangguaAuthError('invalid_session'));
    const store = createHuangguaAccountStore();
    await store.getState().initialize();
    expect(mock.revoke).toHaveBeenCalledWith('fixture-legacy-session');
    expect(mock.clear).toHaveBeenCalledTimes(1);
    expect(store.getState().hasSession).toBe(false);
    expect(store.getState().phase).toBe('error');
    expect(store.getState().error).toBe('invalid_session');
    expect(store.getState().dialogOpen).toBe(true);
  });
  it('does not publish a late login result after the runtime is disposed', async () => {
    let resolveLogin!: (v: unknown) => void;
    mock.login.mockReturnValue(new Promise((resolve) => { resolveLogin = resolve; }));
    const store = createHuangguaAccountStore(); const promise = store.getState().startLogin('fixture', 'password');
    await vi.advanceTimersByTimeAsync(0); store.getState().dispose();
    resolveLogin({ kind: 'authenticated', accessToken: 'fixture-dashboard-token' }); await promise;
    expect(mock.authorize).not.toHaveBeenCalled(); expect(mock.close).toHaveBeenCalledTimes(1); expect(mock.sync).not.toHaveBeenCalled();
  });
});
