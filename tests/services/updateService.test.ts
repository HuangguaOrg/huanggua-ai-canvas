/**
 * updateService — 回归测试：downloadAndInstallUpdate。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadEvent } from '@tauri-apps/plugin-updater';
import type { AppUpdateProgress } from '../../src/services/updateService';

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  prepare: vi.fn(),
  downloadAndInstall: vi.fn(),
  relaunch: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-updater', () => ({ check: mocks.check }));
vi.mock('../../src/services/appUpdateReadiness', () => ({ prepareAppUpdate: mocks.prepare }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: mocks.relaunch }));
vi.mock('@tauri-apps/api/core', () => ({
  Channel: class { onmessage?: (event: DownloadEvent) => void },
  invoke: mocks.invoke,
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
  vi.stubGlobal('window', { __TAURI__: {} });
  mocks.prepare.mockResolvedValue(() => {});
  mocks.downloadAndInstall.mockResolvedValue(undefined);
  mocks.relaunch.mockResolvedValue(undefined);
  mocks.invoke.mockImplementation(async (_command: string, args: { onEvent: { onmessage: (event: DownloadEvent) => void } }) =>
    mocks.downloadAndInstall(args.onEvent.onmessage));
  mocks.check.mockResolvedValue({
    close: vi.fn().mockResolvedValue(undefined),
    rid: 42,
    version: '0.8.18',
    downloadAndInstall: mocks.downloadAndInstall,
  });
});

afterEach(() => { vi.unstubAllEnvs(); });

describe('update discovery failures', () => {
  beforeEach(() => { vi.stubEnv('DEV', false); });

  it('retries a transient installed-client check and finds 0.11.8 without installing it', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.check.mockRejectedValueOnce('error sending request for url (https://gitee.com/feed)')
      .mockResolvedValueOnce({ version: '0.11.8', currentVersion: '0.11.7', close });
    const { checkForUpdate } = await import('../../src/services/updateService');
    await expect(checkForUpdate({ manual: true })).resolves.toMatchObject({ available: true, version: '0.11.8' });
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(mocks.check).toHaveBeenLastCalledWith({ timeout: 30_000, headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } });
    expect(close).toHaveBeenCalledOnce();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('limits failed retries and never reports a network failure as no update', async () => {
    mocks.check.mockRejectedValue('operation timed out');
    const { checkForUpdate } = await import('../../src/services/updateService');
    await expect(checkForUpdate({ manual: true })).rejects.toBe('operation timed out');
    expect(mocks.check).toHaveBeenCalledTimes(2);
  });

  it('does not retry a successful no-update response', async () => {
    mocks.check.mockResolvedValue(null);
    const { checkForUpdate } = await import('../../src/services/updateService');
    await expect(checkForUpdate({ manual: true })).resolves.toEqual({ available: false });
    expect(mocks.check).toHaveBeenCalledOnce();
  });

  it.each([
    ['the platform `darwin-aarch64` was not found in the response `platforms` object', '更新源尚未提供当前系统的安装包，请到官网下载对应版本'],
    ['invalid peer certificate: UnknownIssuer', '更新源安全连接失败，请检查系统时间、证书或网络代理'],
  ])('reports permanent check errors without retry: %s', async (error, message) => {
    mocks.check.mockRejectedValue(error);
    const { checkForUpdate, updateCheckErrorMessage } = await import('../../src/services/updateService');
    await expect(checkForUpdate({ manual: true })).rejects.toBe(error);
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(updateCheckErrorMessage(error)).toBe(message);
  });

  it('reports invalid metadata without displaying raw server content', async () => {
    const { updateCheckErrorMessage } = await import('../../src/services/updateService');
    expect(updateCheckErrorMessage('Could not fetch a valid release JSON from the remote')).toBe('更新源返回了无效清单，请稍后重试或到官网下载');
    expect(updateCheckErrorMessage(new Error('error sending request for url (https://user:password@proxy.invalid)'))).toBe('无法连接更新源，请检查网络或代理设置后重试');
  });

  it('does not turn resource cleanup failure into a failed update check', async () => {
    mocks.check.mockResolvedValue({ version: '0.11.8', close: vi.fn().mockRejectedValue('resource missing') });
    const { checkForUpdate } = await import('../../src/services/updateService');
    await expect(checkForUpdate({ manual: true })).resolves.toMatchObject({ available: true, version: '0.11.8' });
    expect(mocks.check).toHaveBeenCalledOnce();
  });

  it('does not claim to be current when checking in a browser or development build', async () => {
    vi.stubGlobal('window', {});
    const browserService = await import('../../src/services/updateService');
    await expect(browserService.checkForUpdate({ manual: true })).rejects.toThrow('桌面客户端');
    vi.resetModules(); vi.stubGlobal('window', { __TAURI__: {} }); vi.stubEnv('DEV', true);
    const devService = await import('../../src/services/updateService');
    await expect(devService.checkForUpdate({ manual: true })).rejects.toThrow('开发模式');
    await expect(devService.checkForUpdate()).resolves.toEqual({ available: false });
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it('also retries discovery when the user starts an update, but installs only once', async () => {
    mocks.check.mockRejectedValueOnce('operation timed out');
    const { downloadAndInstallUpdate } = await import('../../src/services/updateService');
    await expect(downloadAndInstallUpdate()).resolves.toBe(true);
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });
});

describe('downloadAndInstallUpdate', () => {
  it('没有新版时不暂停工作区', async () => {
    mocks.check.mockResolvedValue(null);
    const { downloadAndInstallUpdate } = await import('../../src/services/updateService');
    await expect(downloadAndInstallUpdate()).resolves.toBe(false);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('用户手动检查时能区分更新源错误和没有新版', async () => {
    vi.stubEnv('DEV', false);
    try {
      mocks.check.mockRejectedValue(new Error('offline'));
      const { checkForUpdate } = await import('../../src/services/updateService');
      await expect(checkForUpdate({ manual: true })).rejects.toThrow('offline');
      await expect(checkForUpdate()).resolves.toEqual({ available: false });
      mocks.check.mockResolvedValue(null);
      await expect(checkForUpdate({ manual: true })).resolves.toEqual({ available: false });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('安装完成后等待应用重启', async () => {
    const { downloadAndInstallUpdate } = await import('../../src/services/updateService');

    await expect(downloadAndInstallUpdate()).resolves.toBe(true);
    expect(mocks.downloadAndInstall).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith('download_app_update', { rid: 42, onEvent: expect.any(Object) });
    expect(mocks.relaunch).toHaveBeenCalledOnce();
    expect(mocks.downloadAndInstall.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.relaunch.mock.invocationCallOrder[0]);
  });

  it('重启失败时向调用方返回失败', async () => {
    mocks.relaunch.mockRejectedValue(new Error('restart denied'));
    const { downloadAndInstallUpdate } = await import('../../src/services/updateService');

    await expect(downloadAndInstallUpdate()).resolves.toBe(false);
  });

  it('累计原生分块字节，并区分下载、安装与重启阶段', async () => {
    const snapshots: AppUpdateProgress[] = [];
    mocks.downloadAndInstall.mockImplementation(async (onEvent: (event: DownloadEvent) => void) => {
      onEvent({ event: 'Started', data: { contentLength: 1000 } });
      onEvent({ event: 'Progress', data: { chunkLength: 250 } });
      onEvent({ event: 'Progress', data: { chunkLength: 750 } });
      onEvent({ event: 'Finished' });
    });
    const { downloadAndInstallUpdate } = await import('../../src/services/updateService');

    await expect(downloadAndInstallUpdate((progress) => snapshots.push(progress))).resolves.toBe(true);

    expect(snapshots).toContainEqual(expect.objectContaining({ phase: 'downloading', downloadedBytes: 250, totalBytes: 1000 }));
    expect(snapshots).toContainEqual(expect.objectContaining({ phase: 'installing', downloadedBytes: 1000, totalBytes: 1000 }));
    expect(snapshots.slice(-2).map(({ phase }) => phase)).toEqual(['restarting', 'complete']);
  });

  it('服务器未提供总大小时只报告真实已下载字节', async () => {
    const snapshots: AppUpdateProgress[] = [];
    mocks.downloadAndInstall.mockImplementation(async (onEvent: (event: DownloadEvent) => void) => {
      onEvent({ event: 'Started', data: {} });
      onEvent({ event: 'Progress', data: { chunkLength: 32 } });
      onEvent({ event: 'Progress', data: { chunkLength: -10 } });
      onEvent({ event: 'Progress', data: { chunkLength: Number.NaN } });
      onEvent({ event: 'Finished' });
    });
    const { downloadAndInstallUpdate } = await import('../../src/services/updateService');

    await downloadAndInstallUpdate((progress) => snapshots.push(progress));

    expect(snapshots.find(({ phase }) => phase === 'installing')).toMatchObject({ downloadedBytes: 32 });
    expect(snapshots.every(({ totalBytes }) => totalBytes === undefined)).toBe(true);
  });

  it('两个更新入口共享一次下载安装', async () => {
    let finishDownload: (() => void) | undefined;
    mocks.downloadAndInstall.mockReturnValue(new Promise<void>((resolve) => { finishDownload = resolve; }));
    const { downloadAndInstallUpdate } = await import('../../src/services/updateService');

    const first = downloadAndInstallUpdate();
    const second = downloadAndInstallUpdate();
    expect(second).toBe(first);
    finishDownload?.();

    await expect(first).resolves.toBe(true);
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(mocks.downloadAndInstall).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });

  it('重启失败时保留准确阶段提示', async () => {
    mocks.relaunch.mockRejectedValue(new Error('restart denied'));
    const snapshots: AppUpdateProgress[] = [];
    const { downloadAndInstallUpdate } = await import('../../src/services/updateService');

    await expect(downloadAndInstallUpdate((progress) => snapshots.push(progress))).resolves.toBe(false);
    expect(snapshots.at(-1)).toMatchObject({ phase: 'error', message: '重启失败，请手动重启应用' });
  });
});
