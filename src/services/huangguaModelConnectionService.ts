/** Provision account-scoped connections using the canvas' existing model protocol runtime. */
import type { ApiProviderConfig, GeneralModelConfig, ProviderModelSelection } from '../types';
import type { ImageModelCapability, NormalizedModelExecutionProtocol, VideoModelCapability } from '../types/aiTypes';
import type { HuangguaModelGrant } from './huangguaAccountService';
import { HUANGGUA_PROVIDER_PREFIX, hydrateHuangguaProviders, isHuangguaManagedProvider, replaceHuangguaCredentials } from './huangguaManagedCredentials';
import metadata from './huangguaModelMetadata.json';
import { areSettingsMutationsFrozen } from './configPersistenceQueue';

const VIDEO_PROTOCOL: NormalizedModelExecutionProtocol = {
  version: 2, mode: 'async', auth: { type: 'bearer' },
  submit: { method: 'POST', path: '/v2/videos', pathMode: 'origin', bodyEncoding: 'json',
    body: { model: '{{model}}', prompt: '{{prompt}}', seconds: '{{duration}}', resolution: '{{resolution}}',
      aspect_ratio: '{{aspectRatio}}',
      first_frame: '{{firstImage}}', end_frame: '{{lastImage}}', images: '{{referenceImageUrls}}' } },
  response: { type: 'json', taskIdPath: 'id', errorPath: 'error.message' },
  poll: { method: 'GET', path: '/v2/videos/{{submit.id}}', pathMode: 'origin', intervalMs: 10000,
    response: { statusPath: 'status', successValues: ['completed'], failureValues: ['failed', 'expired', 'cancelled'],
      errorPath: 'error.message', progressPath: 'progress',
      result: { mimeType: 'video/mp4', download: { method: 'GET', path: '/v2/videos/{{submit.id}}/content', pathMode: 'origin' } } } },
};

const knownModels = metadata.models as unknown as Record<string, {
  name: string; imageCapability?: ImageModelCapability; videoCapability?: VideoModelCapability;
}>;

export function getHuangguaImageCapability(id: string): ImageModelCapability | undefined {
  return knownModels[id]?.imageCapability;
}

export function huangguaModelSelection(category: HuangguaModelGrant['category'], id: string): ProviderModelSelection {
  const known = knownModels[id];
  return {
    id, name: known?.name || id, provider: `${HUANGGUA_PROVIDER_PREFIX}${category}`, category,
    ...(category === 'text' ? {} : category === 'image' ? {
      executionProfile: { preset: 'openai-gpt-image' as const }, imageReferenceRequestMode: 'edits-multipart' as const,
      imageCapability: known?.imageCapability,
    } : { executionProfile: { preset: 'custom' as const, protocol: structuredClone(VIDEO_PROTOCOL) }, videoCapability: known?.videoCapability }),
  };
}

export function buildHuangguaConnections(grants: HuangguaModelGrant[]): Record<string, ApiProviderConfig> {
  const labels = { text: '文本', image: '图片', video: '视频' };
  return Object.fromEntries(grants.filter((grant) => grant.models.length > 0).map((grant) => {
    const id = `${HUANGGUA_PROVIDER_PREFIX}${grant.category}`;
    const models = grant.models.map((model) => huangguaModelSelection(grant.category, model));
    return [id, { name: `黄瓜 AI · ${labels[grant.category]}`, managedBy: 'huanggua-account',
      apiKey: '', baseUrl: 'https://huanggua.my/v1', catalogId: 'custom-openai', chatApiProtocol: 'openai-compatible',
      selectedModels: models, catalogModels: models, visibleModelCategories: [grant.category] } satisfies ApiProviderConfig];
  }));
}

/** Config loading must finish before merging; no request or model key is exposed during startup restoration. */
export async function syncHuangguaModels(grants: HuangguaModelGrant[], isCurrent: () => boolean = () => true): Promise<Record<string, number>> {
  const { useAppStore } = await import('../store/useAppStore');
  if (!useAppStore.getState().configHydrated) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error('config_not_ready')); }, 30000);
      const unsubscribe = useAppStore.subscribe((state) => {
        if (state.configHydrated) { clearTimeout(timer); unsubscribe(); resolve(); }
      });
      if (useAppStore.getState().configHydrated) { clearTimeout(timer); unsubscribe(); resolve(); }
    });
  }
  if (!isCurrent()) return {};
  if (areSettingsMutationsFrozen()) throw new Error('config_frozen');
  const state = useAppStore.getState();
  const created = buildHuangguaConnections(grants);
  for (const id of Object.keys(created)) {
    const existing = state.config.providers[id];
    if (existing && !isHuangguaManagedProvider(id, existing)) throw new Error('connection_conflict');
  }
  const oldManagedIds = new Set(Object.entries(state.config.providers).filter(([id, p]) => isHuangguaManagedProvider(id, p)).map(([id]) => id));
  const providers = Object.fromEntries(Object.entries(state.config.providers).filter(([id]) => !oldManagedIds.has(id)));
  const retained = (state.config.generalModels ?? []).filter((m) => !oldManagedIds.has(m.providerConfigId));
  const models: GeneralModelConfig[] = Object.entries(created).flatMap(([providerConfigId, provider]) =>
    (provider.selectedModels ?? []).map((model) => ({ id: `${providerConfigId}/${encodeURIComponent(model.id)}`,
      name: model.name, modelId: model.id, category: model.category, providerConfigId,
      executionProfile: model.executionProfile, imageReferenceRequestMode: model.imageReferenceRequestMode,
      imageCapability: model.imageCapability, videoCapability: model.videoCapability })));
  replaceHuangguaCredentials(grants.map((grant) => [`${HUANGGUA_PROVIDER_PREFIX}${grant.category}`, grant.apiKey]));
  const availableIds = new Set([...retained, ...models].map((m) => m.id));
  const chooseDefault = (current: string | undefined, category: 'text' | 'image' | 'video') => {
    // Keep unrelated user choices, including built-in model IDs.
    if (current && !current.replace(/^general\//, '').startsWith(HUANGGUA_PROVIDER_PREFIX)) return current;
    if (current && availableIds.has(current.replace(/^general\//, ''))) return current;
    if (category === 'text') {
      return (models.find((m) => m.category === 'text' && /^gpt-/i.test(m.modelId) && !/(image|audio|realtime)/i.test(m.modelId))
        ?? models.find((m) => m.category === 'text'))?.id;
    }
    return models.find((m) => m.category === category)?.id;
  };
  const wasDirty = !!state.configDirty;
  state.updateConfig({ providers: hydrateHuangguaProviders({ ...providers, ...created }), generalModels: [...retained, ...models],
    assistantModelId: chooseDefault(state.config.assistantModelId, 'text'),
    assistantImageModelId: chooseDefault(state.config.assistantImageModelId, 'image'),
    assistantVideoModelId: chooseDefault(state.config.assistantVideoModelId, 'video') });
  const synced = useAppStore.getState();
  if (!wasDirty && synced.configHydrated && synced.configDirty) {
    await synced.saveConfig?.({ silent: true }).catch(() => {});
  }
  return Object.fromEntries(['text', 'image', 'video'].map((category) => [category, models.filter((m) => m.category === category).length]));
}

/** Drop secrets synchronously, then remove only the account-owned connections. Project references remain reusable. */
export async function clearHuangguaModels(): Promise<void> {
  replaceHuangguaCredentials([]);
  const { useAppStore } = await import('../store/useAppStore');
  await useAppStore.getState().disconnectStudio?.();
  const state = useAppStore.getState();
  const { config, updateConfig } = state;
  const managed = new Set(Object.entries(config.providers).filter(([id, p]) => isHuangguaManagedProvider(id, p)).map(([id]) => id));
  if (!managed.size) return;
  const wasDirty = !!state.configDirty;
  const keepDefault = (id: string | undefined) => id?.replace(/^general\//, '').startsWith(HUANGGUA_PROVIDER_PREFIX) ? undefined : id;
  updateConfig({ providers: Object.fromEntries(Object.entries(config.providers).filter(([id]) => !managed.has(id))),
    generalModels: config.generalModels?.filter((m) => !managed.has(m.providerConfigId)),
    assistantModelId: keepDefault(config.assistantModelId), assistantImageModelId: keepDefault(config.assistantImageModelId),
    assistantVideoModelId: keepDefault(config.assistantVideoModelId) });
  const cleared = useAppStore.getState();
  if (!wasDirty && cleared.configHydrated && cleared.configDirty) {
    await cleared.saveConfig?.({ silent: true }).catch(() => {});
  }
}
