import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../src/types';
import { buildHuangguaConnections, clearHuangguaModels, huangguaModelSelection, syncHuangguaModels } from '../../src/services/huangguaModelConnectionService';
import { hydrateHuangguaProviders, replaceHuangguaCredentials } from '../../src/services/huangguaManagedCredentials';
import { parseModelExecutionProtocol, validateModelExecutionProtocol } from '../../src/services/ai/modelProtocolValidation';
import { assertModelCapabilityProtocol } from '../../src/services/ai/modelCapabilityValidation';
import { buildModelProtocolRequest } from '../../src/services/ai/modelProtocolRequest';
import { resolveImageTemplateDimensions } from '../../src/services/ai/imageModelTemplates';
import { formatImageSizeForModel } from '../../src/services/ai/helpers';
import metadata from '../../src/services/huangguaModelMetadata.json';

const mock = vi.hoisted(() => ({ getState: vi.fn(), subscribe: vi.fn(), frozen: false }));
vi.mock('../../src/store/useAppStore', () => ({ useAppStore: { getState: mock.getState, subscribe: mock.subscribe } }));
vi.mock('../../src/services/configPersistenceQueue', () => ({ areSettingsMutationsFrozen: () => mock.frozen }));
const grants = [{ category: 'text' as const, apiKey: 'fixture-text-key', models: ['gpt-fixture'] },
  { category: 'image' as const, apiKey: 'fixture-image-key', models: ['grsai-gpt-image-2.6'] },
  { category: 'video' as const, apiKey: 'fixture-video-key', models: ['grsai-minimax-h3-768p'] }];
let config: AppConfig;
beforeEach(() => {
  replaceHuangguaCredentials([]); mock.frozen = false;
  config = { providers: { personal: { name: '我的连接', apiKey: 'personal-fixture', baseUrl: 'https://example.test/v1' } },
    generalModels: [{ id: 'personal-model', name: '个人模型', category: 'text', modelId: 'personal', providerConfigId: 'personal' }],
    assistantModelId: 'personal-model', theme: 'dark' } as AppConfig;
  mock.getState.mockImplementation(() => ({ config, configHydrated: true, updateConfig: (patch: Partial<AppConfig>) => {
    config = { ...config, ...patch };
  } }));
});

describe('automatic Huanggua model provisioning', () => {
  it('creates all permitted categories without overwriting user connections or their defaults', async () => {
    expect(await syncHuangguaModels(grants)).toEqual({ text: 1, image: 1, video: 1 });
    expect(config.providers.personal.apiKey).toBe('personal-fixture');
    expect(config.assistantModelId).toBe('personal-model');
    expect(config.providers['huanggua-account-text'].apiKey).toBe('fixture-text-key');
    expect(config.providers['huanggua-account-image'].apiKey).toBe('fixture-image-key');
    expect(config.providers['huanggua-account-video'].apiKey).toBe('fixture-video-key');
    expect(config.generalModels).toHaveLength(4);
    await syncHuangguaModels(grants); expect(config.generalModels).toHaveLength(4);
  });
  it('removes only managed models and credentials on logout or permission loss', async () => {
    await syncHuangguaModels(grants);
    const oldProviders = config.providers;
    await clearHuangguaModels();
    expect(Object.keys(config.providers)).toEqual(['personal']);
    expect(config.generalModels).toHaveLength(1);
    expect(hydrateHuangguaProviders(oldProviders)['huanggua-account-text'].apiKey).toBe('');
  });
  it('does not apply a stale account snapshot or overwrite a manually owned connection', async () => {
    await syncHuangguaModels(grants, () => false); expect(Object.keys(config.providers)).toEqual(['personal']);
    config.providers['huanggua-account-text'] = { name: '用户自建', apiKey: 'keep-me' };
    await expect(syncHuangguaModels(grants)).rejects.toThrow('connection_conflict');
    expect(config.providers['huanggua-account-text'].apiKey).toBe('keep-me');
  });
  it('does not claim model provisioning while settings are frozen', async () => {
    mock.frozen = true; await expect(syncHuangguaModels(grants)).rejects.toThrow('config_frozen');
    expect(Object.keys(config.providers)).toEqual(['personal']);
  });
  it('reuses the three fixed managed connections and prefers a gpt chat model over non-chat entries', async () => {
    config = { providers: {}, generalModels: [], theme: 'dark' } as AppConfig;
    const fixedGrants = [
      { category: 'text' as const, apiKey: `sk-ad1.${'a'.repeat(64)}.text.${'b'.repeat(64)}`, models: ['codex-auto-review', 'gpt-5.6', 'gpt-6.1-sol'] },
      { category: 'image' as const, apiKey: `sk-ad1.${'a'.repeat(64)}.image.${'b'.repeat(64)}`, models: ['grsai-gpt-image-2.6'] },
      { category: 'video' as const, apiKey: `sk-ad1.${'a'.repeat(64)}.video.${'b'.repeat(64)}`, models: ['grsai-minimax-h3-768p'] },
    ];
    expect(await syncHuangguaModels(fixedGrants)).toEqual({ text: 3, image: 1, video: 1 });
    expect(Object.keys(config.providers)).toEqual(['huanggua-account-text', 'huanggua-account-image', 'huanggua-account-video']);
    expect(config.assistantModelId).toBe('huanggua-account-text/gpt-5.6');
    expect(config.providers['huanggua-account-text'].apiKey).toBe(fixedGrants[0].apiKey);
    await syncHuangguaModels(fixedGrants);
    expect(Object.keys(config.providers)).toEqual(['huanggua-account-text', 'huanggua-account-image', 'huanggua-account-video']);
    expect(config.generalModels).toHaveLength(5);
  });
  it('silently persists clean settings on sync and logout without flushing pre-existing dirty edits', async () => {
    let dirty = false;
    const saveConfig = vi.fn(async () => { dirty = false; });
    mock.getState.mockImplementation(() => ({
      config, configHydrated: true, configDirty: dirty, saveConfig,
      updateConfig: (patch: Partial<AppConfig>) => { config = { ...config, ...patch }; dirty = true; },
    }));
    await syncHuangguaModels(grants);
    expect(saveConfig).toHaveBeenCalledWith({ silent: true });
    expect(dirty).toBe(false);

    dirty = true;
    saveConfig.mockClear();
    await clearHuangguaModels();
    expect(saveConfig).not.toHaveBeenCalled();
  });
  it('maps every GrsAI image model resolution and aspect ratio to exact gateway-supported pixel sizes', () => {
    const allowedSizes = new Set([
      '1024x1024', '2048x2048', '2880x2880',
      '1280x720', '2048x1152', '3840x2160',
      '720x1280', '1152x2048', '2160x3840',
      '1152x864', '2304x1728', '3264x2448',
      '864x1152', '1728x2304', '2448x3264',
      '1536x1024', '2048x1360', '3504x2336',
      '1024x1536', '1360x2048', '2336x3504',
      '1120x896', '2240x1792', '3200x2560',
      '896x1120', '1792x2240', '2560x3200',
      '1456x624', '2912x1248', '3840x1648',
    ]);
    const grsaiImageIds = Object.entries(metadata.models)
      .filter(([id, entry]) => id.startsWith('grsai-') && 'imageCapability' in entry)
      .map(([id]) => id);
    expect(grsaiImageIds).toHaveLength(18);
    for (const modelId of grsaiImageIds) {
      const selection = huangguaModelSelection('image', modelId);
      assertModelCapabilityProtocol(selection);
      const capability = selection.imageCapability!;
      for (const resolution of capability.resolutions ?? []) {
        for (const ratio of capability.ratios ?? []) {
          const dims = resolveImageTemplateDimensions(capability, resolution, ratio);
          expect(allowedSizes.has(formatImageSizeForModel(modelId, dims))).toBe(true);
        }
      }
    }
  });
  it('builds a valid native V2 video protocol with authenticated same-origin result download', () => {
    const selection = huangguaModelSelection('video', 'grsai-minimax-h3-768p');
    const protocol = parseModelExecutionProtocol(selection.executionProfile!.protocol!);
    expect(validateModelExecutionProtocol(protocol)).toEqual([]);
    const request = buildModelProtocolRequest({ apiKey: 'fixture-video-key', baseUrl: 'https://huanggua.my/v1', protocol,
      variables: { model: selection.id, prompt: 'fixture', duration: 5, resolution: '768p', aspectRatio: '16:9', referenceImageUrls: ['https://example.test/reference.png'] } });
    expect(request.url).toBe('https://huanggua.my/v2/videos');
    expect(request.renderedBody).toMatchObject({ seconds: 5, images: ['https://example.test/reference.png'] });
    expect(request.renderedBody).not.toHaveProperty('first_frame');
    expect(protocol.poll?.response.result?.download).toMatchObject({ method: 'GET', path: '/v2/videos/{{submit.id}}/content', pathMode: 'origin' });
    expect(JSON.stringify(buildHuangguaConnections(grants))).not.toContain('fixture-video-key');
  });
});


it('updates an open studio after replacing canvas models, without duplicating personal models', async () => {
  const refreshStudioModels = vi.fn(async () => {
    expect(config.generalModels?.some(model => model.modelId === 'gpt-latest')).toBe(true);
    expect(config.generalModels?.some(model => model.modelId === 'gpt-fixture')).toBe(false);
  });
  await syncHuangguaModels(grants);
  const previous = mock.getState.getMockImplementation()!;
  mock.getState.mockImplementation(() => ({ ...previous(), refreshStudioModels }));
  await syncHuangguaModels([{ ...grants[0], models: ['gpt-latest'] }]);
  expect(refreshStudioModels).toHaveBeenCalledTimes(1);
  expect(config.generalModels).toHaveLength(2);
  expect(config.generalModels?.find(model => model.id === 'personal-model')).toBeDefined();
  expect(config.providers['huanggua-account-image']).toBeUndefined();
});
