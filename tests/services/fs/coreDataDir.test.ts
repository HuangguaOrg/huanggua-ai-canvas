/**
 * coreDataDir — 默认目录查询合并、失败恢复与自定义目录实时切换。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const paths = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tauri-apps/api/core')>(),
  invoke: paths.invoke,
}));

beforeEach(() => {
  vi.resetModules();
  paths.invoke.mockReset().mockResolvedValue('/install/data');
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
});
afterEach(() => vi.unstubAllGlobals());

describe('default storage directory', () => {
  it('coalesces concurrent path queries and reuses a successful native directory', async () => {
    let resolve!: (directory: string) => void;
    paths.invoke.mockImplementation(() => new Promise<string>((finish) => { resolve = finish; }));
    const core = await import('../../../src/services/fs/core');
    const requests = [core.getDefaultBaseDir(), core.getBaseDir(), core.getProjectDataDir('project')];
    // 路径调用在微任务内启动，让所有入口共享同一次查询。
    await Promise.resolve();
    expect(paths.invoke).toHaveBeenCalledOnce();
    expect(paths.invoke).toHaveBeenCalledWith('get_default_project_data_root');
    resolve('/install/data');
    expect(await Promise.all(requests)).toEqual(['/install/data', '/install/data', '/install/data/project']);
    expect(await core.getProjectDataDir('another')).toBe('/install/data/another');
    expect(await core.getDefaultBaseDir()).toBe('/install/data');
    expect(paths.invoke).toHaveBeenCalledOnce();
  });

  it.each(['rejection', 'throw', 'empty'] as const)('does not retain an unsuccessful %s query', async (failure) => {
    if (failure === 'rejection') paths.invoke.mockRejectedValueOnce(new Error('unavailable'));
    else if (failure === 'throw') paths.invoke.mockImplementationOnce(() => { throw new Error('unavailable'); });
    else paths.invoke.mockResolvedValueOnce('');
    const core = await import('../../../src/services/fs/core');
    const results = await Promise.allSettled([core.getDefaultBaseDir(), core.getProjectDataDir('project')]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(paths.invoke).toHaveBeenCalledOnce();
    expect(await core.getDefaultBaseDir()).toBe('/install/data');
    expect(await core.getProjectDataDir('project')).toBe('/install/data/project');
    expect(paths.invoke).toHaveBeenCalledTimes(2);
  });

  it('checks the runtime before querying or returning a cached native directory', async () => {
    vi.stubGlobal('window', {});
    const core = await import('../../../src/services/fs/core');
    expect(await core.getDefaultBaseDir()).toBeNull();
    expect(paths.invoke).not.toHaveBeenCalled();
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    expect(await core.getDefaultBaseDir()).toBe('/install/data');
    vi.stubGlobal('window', {});
    expect(await core.getDefaultBaseDir()).toBeNull();
    expect(paths.invoke).toHaveBeenCalledOnce();
  });

  it('keeps custom roots and project folder mappings live without invalidating the native directory', async () => {
    const core = await import('../../../src/services/fs/core');
    core.setBaseDataDir('/custom');
    core.registerProjectFolder('episode', 'series');
    expect(await core.getBaseDir()).toBe('/custom');
    expect(await core.getProjectDataDir('episode')).toBe('/custom/series');
    expect(paths.invoke).not.toHaveBeenCalled();
    expect(await core.getDefaultBaseDir()).toBe('/install/data');
    core.setBaseDataDir('/moved');
    core.registerProjectFolder('episode', 'renamed');
    expect(await core.getProjectDataDir('episode')).toBe('/moved/renamed');
    core.setBaseDataDir(undefined);
    expect(await core.getBaseDir()).toBe('/install/data');
    expect(await core.getProjectDataDir('episode')).toBe('/install/data/renamed');
    expect(paths.invoke).toHaveBeenCalledOnce();
  });

  it('does not let a pending default query replace a newly chosen custom root', async () => {
    let resolve!: (directory: string) => void;
    paths.invoke.mockImplementation(() => new Promise<string>((finish) => { resolve = finish; }));
    const core = await import('../../../src/services/fs/core');
    const defaultQuery = core.getDefaultBaseDir();
    await Promise.resolve();
    core.setBaseDataDir('/chosen');
    expect(await core.getBaseDir()).toBe('/chosen');
    resolve('/install/data');
    expect(await defaultQuery).toBe('/install/data');
    expect(await core.getBaseDir()).toBe('/chosen');
    expect(await core.getProjectDataDir('project')).toBe('/chosen/project');
  });

  it.each(['\\\\server\\share\\', '//server/share/'])(
    'preserves the UNC prefix of a custom storage root %s', async (root) => {
      const core = await import('../../../src/services/fs/core');
      core.setBaseDataDir(root);
      core.registerProjectFolder('episode', '剧集');
      const directory = await core.getProjectDataDir('episode');
      expect(directory).toBe('//server/share/剧集');
      expect(core.joinPath(directory ?? '', 'Library', '候选.png')).toBe('//server/share/剧集/Library/候选.png');
      expect(core.joinPath('C:\\projects\\', 'Library')).toBe('C:/projects/Library');
      expect(core.joinPath('/projects//', 'Library')).toBe('/projects/Library');
      expect(core.joinPath('\\\\?\\UNC\\server\\share', 'Library')).toBe('//?/UNC/server/share/Library');
    },
  );
});
