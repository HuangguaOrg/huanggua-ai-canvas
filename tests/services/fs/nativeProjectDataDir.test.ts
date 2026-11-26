import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ invoke: vi.fn(), appDataDir: vi.fn(async () => '/app') }));
vi.mock('@tauri-apps/api/core', async (original) => ({
  ...await original<typeof import('@tauri-apps/api/core')>(), invoke: native.invoke,
}));
vi.mock('@tauri-apps/api/path', async (original) => ({
  ...await original<typeof import('@tauri-apps/api/path')>(), appDataDir: native.appDataDir,
}));

const projectId = 'p2-12345678-1234-4123-8123-123456789abc';
const canvasId = 'c2-12345678-1234-4123-8123-123456789abc';
const episodeId = 'e2-12345678-1234-4123-8123-123456789abc';

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
  native.invoke.mockReset().mockImplementation(async command => command === 'sync_authorized_directories' ? [] : command === 'get_default_project_data_root' ? '/app/data' : '/bound/project');
});
afterEach(() => vi.unstubAllGlobals());

describe('新旧项目素材根路由', () => {
  it.each(['/chosen', undefined])('目录同步失效时只重同步已加载的根 %s，并重新执行原生校验', async (root) => {
    const core = await import('../../../src/services/fs/core');
    core.setBaseDataDir(root);
    core.registerNativeProjectFolders([{ id: canvasId, projectId }]);
    native.invoke.mockRejectedValueOnce('项目存储目录尚未同步或不可用')
      .mockResolvedValueOnce([]).mockResolvedValueOnce('/bound/project');
    expect(await core.getProjectDataDir(canvasId)).toBe('/bound/project');
    expect(native.invoke.mock.calls).toEqual([
      ['resolve_native_project_media_root', { projectId }],
      ['sync_authorized_directories', { directories: root ? [root] : [], baseDataDir: root ?? null }],
      ['resolve_native_project_media_root', { projectId }],
    ]);
  });

  it('未加载根配置时不把自定义目录重置成默认目录', async () => {
    const core = await import('../../../src/services/fs/core');
    core.registerNativeProjectFolders([{ id: canvasId, projectId }]);
    native.invoke.mockRejectedValue('项目存储目录尚未同步或不可用');
    await expect(core.getProjectDataDir(canvasId)).rejects.toThrow('配置尚未就绪');
    expect(native.invoke).toHaveBeenCalledOnce();
  });

  it('目录仍不可用时有界失败且不写入默认盘', async () => {
    const core = await import('../../../src/services/fs/core');
    core.setBaseDataDir('/offline');
    core.registerNativeProjectFolders([{ id: canvasId, projectId }]);
    native.invoke.mockImplementation(async (command) => {
      if (command === 'sync_authorized_directories') return ['/offline'];
      throw '项目存储目录尚未同步或不可用';
    });
    await expect(core.getProjectDataDir(canvasId)).rejects.toMatchObject({
      name: 'ProjectStorageUnavailableError', message: expect.stringContaining('原保存根目录'),
    });
    expect(native.invoke).toHaveBeenCalledTimes(2);
    expect(native.invoke).toHaveBeenNthCalledWith(2, 'sync_authorized_directories', { directories: ['/offline'], baseDataDir: '/offline' });
  });

  it('同步失败保留原错误原因，后续用户重试仍可恢复', async () => {
    const core = await import('../../../src/services/fs/core');
    core.setBaseDataDir('/chosen');
    core.registerNativeProjectFolders([{ id: canvasId, projectId }]);
    const failure = new Error('permission denied');
    native.invoke.mockRejectedValueOnce('项目存储目录尚未同步或不可用').mockRejectedValueOnce(failure);
    await expect(core.getProjectDataDir(canvasId)).rejects.toMatchObject({ name: 'ProjectStorageUnavailableError', cause: failure });
    native.invoke.mockRejectedValueOnce('项目存储目录尚未同步或不可用').mockResolvedValueOnce([]).mockResolvedValueOnce('/bound/project');
    expect(await core.getProjectDataDir(canvasId)).toBe('/bound/project');
  });

  it('并发目录读取共享一次同步，媒体身份解析仍逐项核对', async () => {
    const core = await import('../../../src/services/fs/core');
    core.setBaseDataDir('/chosen');
    core.registerNativeProjectFolders([{ id: canvasId, projectId }]);
    let finish!: () => void;
    let synced = false;
    native.invoke.mockImplementation(async (command) => {
      if (command === 'sync_authorized_directories') {
        await new Promise<void>(resolve => { finish = resolve; });
        synced = true; return [];
      }
      if (!synced) throw '项目存储目录尚未同步或不可用';
      return '/bound/project';
    });
    const first = core.getProjectDataDir(canvasId), second = core.getProjectDataDir(canvasId);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    finish();
    expect(await Promise.all([first, second])).toEqual(['/bound/project', '/bound/project']);
    expect(native.invoke.mock.calls.filter(([command]) => command === 'sync_authorized_directories')).toHaveLength(1);
  });

  it('同步期间切换根目录不再重试原操作，也不接受旧目录结果', async () => {
    const core = await import('../../../src/services/fs/core');
    core.setBaseDataDir('/old');
    core.registerNativeProjectFolders([{ id: canvasId, projectId }]);
    native.invoke.mockRejectedValueOnce('项目存储目录尚未同步或不可用').mockImplementationOnce(async () => {
      core.setBaseDataDir('/new'); return [];
    });
    await expect(core.getProjectDataDir(canvasId)).rejects.toThrow('存储设置已变化');
    expect(native.invoke).toHaveBeenCalledTimes(2);
  });

  it('搜索子窗口不能用自己的配置覆盖主窗口存储根', async () => {
    const core = await import('../../../src/services/fs/core');
    core.setBaseDataDir('/stale'); core.activateNativeAssetSearchContext();
    core.registerNativeProjectFolders([{ id: canvasId, projectId }]);
    native.invoke.mockRejectedValue('项目存储目录尚未同步或不可用');
    await expect(core.getProjectDataDir(canvasId)).rejects.toThrow('主窗口');
    expect(native.invoke).toHaveBeenCalledOnce();
  });

  it('创建目录属于写操作，失败时不自动重放', async () => {
    const core = await import('../../../src/services/fs/core');
    core.setBaseDataDir('/chosen');
    native.invoke.mockResolvedValueOnce([]).mockRejectedValueOnce('项目存储目录尚未同步或不可用');
    await expect(core.claimNativeProjectDataDir(projectId, '作品')).rejects.toMatchObject({ name: 'ProjectStorageUnavailableError' });
    expect(native.invoke.mock.calls.filter(([command]) => command === 'claim_native_project_media_root')).toHaveLength(1);
  });

  it('新建透传项目名，实体可读目录由原生绑定返回，读取时不按显示名重新拼路径', async () => {
    const core = await import('../../../src/services/fs/core');
    core.setBaseDataDir(undefined);
    const directory = '/bound/新项目结构测试-12345678';
    native.invoke.mockImplementation(async command => command === 'sync_authorized_directories' ? [] : directory);
    core.registerNativeProjectFolders([{ id: canvasId, projectId }]);
    expect(await core.claimNativeProjectDataDir(projectId, '新项目结构测试')).toBe(directory);
    expect(await core.getProjectDataDir(canvasId)).toBe(directory);
    expect(native.invoke).toHaveBeenNthCalledWith(2, 'claim_native_project_media_root', { projectId, projectName: '新项目结构测试' });
    expect(native.invoke).toHaveBeenNthCalledWith(3, 'resolve_native_project_media_root', { projectId });
  });

  it('搜索窗口只使用专用只读命令，主窗口同步显式作品列表', async () => {
    const core = await import('../../../src/services/fs/core');
    await core.syncNativeAssetSearchRoots([projectId]);
    core.registerNativeProjectFolders([{ id: canvasId, projectId }]);
    core.activateNativeAssetSearchContext();
    expect(await core.getProjectDataDir(canvasId)).toBe('/bound/project');
    expect(native.invoke).toHaveBeenNthCalledWith(1, 'sync_native_asset_search_roots', { projectIds: [projectId] });
    expect(native.invoke).toHaveBeenNthCalledWith(2, 'resolve_asset_search_native_project_root', { projectId });
  });
  it('通过显式作品与画布绑定解析原生素材根，不回退旧目录', async () => {
    const core = await import('../../../src/services/fs/core');
    core.setBaseDataDir(undefined);
    core.registerNativeProjectFolders([projectId, canvasId, episodeId].map((id) => ({ id, projectId })));
    expect(await core.claimNativeProjectDataDir(projectId)).toBe('/bound/project');
    expect(await core.getProjectDataDir(canvasId)).toBe('/bound/project');
    expect(await core.ensureProjectDataDir(episodeId)).toBe('/bound/project');
    expect(native.invoke).toHaveBeenNthCalledWith(2, 'claim_native_project_media_root', { projectId });
    expect(native.invoke).toHaveBeenNthCalledWith(3, 'resolve_native_project_media_root', { projectId });
    expect(native.invoke).toHaveBeenNthCalledWith(4, 'resolve_native_project_media_root', { projectId });
    expect(core.isSharedProjectDataDir(canvasId)).toBe(true);
  });

  it('未确认的候选 ID 不落旧根，真正同形旧 ID 显式登记后保持旧路径', async () => {
    const core = await import('../../../src/services/fs/core');
    await expect(core.getProjectDataDir(canvasId)).rejects.toThrow('身份尚未确认');
    core.registerProjectFolder(canvasId, undefined);
    expect(await core.getProjectDataDir(canvasId)).toBe(`/app/data/${canvasId}`);
    expect(() => core.registerNativeProjectFolders([{ id: canvasId, projectId }])).toThrow('身份冲突');
    expect(native.invoke).toHaveBeenCalledExactlyOnceWith('get_default_project_data_root');
  });

  it('原生根不可用时不静默回退；批量绑定冲突不提交部分映射', async () => {
    const core = await import('../../../src/services/fs/core');
    core.registerProjectFolder(episodeId, 'old');
    expect(() => core.registerNativeProjectFolders([{ id: canvasId, projectId }, { id: episodeId, projectId }])).toThrow();
    await expect(core.getProjectDataDir(canvasId)).rejects.toThrow('身份尚未确认');
    core.registerNativeProjectFolders([{ id: canvasId, projectId }]);
    native.invoke.mockRejectedValueOnce(new Error('root unavailable'));
    await expect(core.ensureProjectDataDir(canvasId)).rejects.toThrow('root unavailable');
  });
});


describe('新建画布目录同步前置', () => {
  it.each(['/chosen', undefined])('先同步已加载的保存根再执行一次创建：%s', async root => {
    const core = await import('../../../src/services/fs/core'); core.setBaseDataDir(root);
    expect(await core.claimNativeProjectDataDir(projectId, '新画布')).toBe('/bound/project');
    expect(native.invoke.mock.calls).toEqual([
      ['sync_authorized_directories', { directories: root ? [root] : [], baseDataDir: root ?? null }],
      ['claim_native_project_media_root', { projectId, projectName: '新画布' }],
    ]);
  });
  it('原目录离线时不创建项目，不回退默认盘，恢复后允许重试', async () => {
    const core = await import('../../../src/services/fs/core'); core.setBaseDataDir('/offline');
    native.invoke.mockResolvedValueOnce(['/offline']);
    await expect(core.claimNativeProjectDataDir(projectId)).rejects.toThrow('原保存根目录');
    expect(native.invoke).toHaveBeenCalledTimes(1);
    expect(await core.claimNativeProjectDataDir(projectId)).toBe('/bound/project');
    expect(native.invoke.mock.calls.filter(([command]) => command === 'claim_native_project_media_root')).toHaveLength(1);
    expect(native.invoke).toHaveBeenNthCalledWith(2, 'sync_authorized_directories', { directories: ['/offline'], baseDataDir: '/offline' });
  });
  it('配置未加载时不把保存根重置成默认位置', async () => {
    const core = await import('../../../src/services/fs/core');
    await expect(core.claimNativeProjectDataDir(projectId)).rejects.toThrow('配置尚未就绪');
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it('同步期间切换保存目录后不继续创建', async () => {
    const core = await import('../../../src/services/fs/core'); core.setBaseDataDir('/old');
    native.invoke.mockImplementationOnce(async () => { core.setBaseDataDir('/new'); return []; });
    await expect(core.claimNativeProjectDataDir(projectId)).rejects.toThrow('存储设置已变化');
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });
  it('原生目录归属字符串错误变成可显示的存储异常，不再隐藏成通用切换失败', async () => {
    const core = await import('../../../src/services/fs/core'); core.setBaseDataDir('/chosen');
    core.registerNativeProjectFolders([{ id: canvasId, projectId }]);
    const nativeError = '新项目素材目录不可用或归属未能确认，原有文件已保留';
    native.invoke.mockRejectedValueOnce(nativeError);
    await expect(core.getProjectDataDir(canvasId)).rejects.toMatchObject({ name: 'ProjectStorageUnavailableError', message: expect.stringContaining('访问权限'), cause: nativeError });
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });
  it('同步失败不执行创建，也不自动重放写入', async () => {
    const core = await import('../../../src/services/fs/core'); core.setBaseDataDir('/chosen');
    native.invoke.mockRejectedValueOnce('network-or-permission');
    await expect(core.claimNativeProjectDataDir(projectId)).rejects.toThrow('原保存根目录');
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });
});
