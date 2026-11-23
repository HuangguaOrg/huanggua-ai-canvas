/**
 * huangguaPricing — 计算黄瓜 AI（huanggua.my）图片与视频模型的单价和单次生成收费。
 *
 * 定价口径与官网 Creative Studio（estimateHold / nativeImagePrice / grsai-media）完全一致：
 * 1. 内置官网已审阅模型目录作为零延迟离线基线；
 * 2. 后台拉取公开接口 GET https://huanggua.my/api/pricing 同步实时倍率与分组系数；
 * 3. 不包含任何凭据或私有地址。
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { AppConfig, BaseNodeData, GeneralModelConfig } from '../../types';
import type { ImageModelCapability, VideoModelCapability } from '../../types/aiTypes';
import { HUANGGUA_ORIGIN } from '../huangguaAccountService';
import { HUANGGUA_PROVIDER_PREFIX, isHuangguaManagedProvider } from '../huangguaManagedCredentials';
import { corsSafeFetch } from '../ai/httpTransport';
import rawCatalog from './huangguaPricingCatalog.json';

interface GrsaiCatalogItem {
  kind: 'image' | 'video';
  credits: number;
  resolution?: string;
}

interface CatcodeImageCatalogItem {
  prices: Record<string, number>;
}

interface CatcodeVideoVariant {
  resolution: string;
  price: number;
  durations: number[];
}

interface CatcodeVideoCatalogItem {
  pricingMode: 'task' | 'second' | 'video_token' | string;
  includedImages: number;
  extraImagePrice: number;
  referenceVideoModelPrice: boolean;
  variants: CatcodeVideoVariant[];
}

interface PricingCatalogData {
  defaultGrsaiRate: number;
  defaultCatcodeFactor: number;
  grsai: Record<string, GrsaiCatalogItem>;
  catcodeImages: Record<string, CatcodeImageCatalogItem>;
  catcodeVideos: Record<string, CatcodeVideoCatalogItem>;
}

const catalog = rawCatalog as unknown as PricingCatalogData;

export interface LivePricingModelEntry {
  modelName: string;
  billingMode?: string;
  billingExpr?: string;
  modelPrice?: number;
  quotaType?: number;
  enableGroups?: string[];
}

export interface HuangguaLivePricingSnapshot {
  models: ReadonlyMap<string, LivePricingModelEntry>;
  groupRatio: Readonly<Record<string, number>>;
  fetchedAt: number;
}

export interface HuangguaTariffSummary {
  /** 用于模型下拉列表展示的简明单价，例如 "$0.06/张"、"$0.14/秒"、"$9.75/次" */
  unitBadge: string;
  minUsd: number;
  maxUsd: number;
  unit: 'image' | 'second' | 'task';
}

export interface HuangguaMediaCostQuote {
  amountUsd: number;
  formattedAmount: string;
  pricingKind: 'fixed_image' | 'fixed_task' | 'per_second';
  unitFormatted: string;
  /** 不含货币前后文案的计算明细，例如 "$0.14/秒 × 12s" 或 "$0.06/张" */
  breakdown: string;
  isAutoDuration?: boolean;
}

export interface ResolvedHuangguaNodeModel {
  modelId: string;
  providerConfigId: string;
  imageCapability?: ImageModelCapability;
  videoCapability?: VideoModelCapability;
}

const GRSAI_EXPR_RE = /^\s*tier\(\s*"grsai"\s*,\s*u\(\s*"credits"\s*\)\s*\*\s*(\d+(?:\.\d+)?)\s*\)\s*$/;
const CATCODE_EXPR_RE = /^\s*tier\(\s*"catcode"\s*,\s*u\(\s*"credits"\s*\)\s*\*\s*(\d+(?:\.\d+)?)\s*\)\s*$/;
const NATIVE_IMAGE_EXPR_RE = /^\s*tier\(\s*"image"\s*,\s*fixed\(\s*(\d+(?:\.\d+)?)\s*\)\s*\)\s*\*\s*image_count\s*$/;
const GEMINI_TIERED_IMAGE_RE = /tier\(\s*"4K"\s*,\s*fixed\(\s*(\d+(?:\.\d+)?)\s*\)\s*\)[\s\S]*tier\(\s*"2K"\s*,\s*fixed\(\s*(\d+(?:\.\d+)?)\s*\)\s*\)[\s\S]*tier\(\s*"1K"\s*,\s*fixed\(\s*(\d+(?:\.\d+)?)\s*\)\s*\)\s*\)\s*\*\s*image_count/;

const LIVE_CACHE_TTL_MS = 5 * 60 * 1000;
let liveSnapshot: HuangguaLivePricingSnapshot | null = null;
let liveVersion = 0;
let inflightFetch: Promise<HuangguaLivePricingSnapshot | null> | null = null;
const listeners = new Set<() => void>();

function notifyPricingListeners(): void {
  liveVersion += 1;
  for (const listener of listeners) listener();
}

export function subscribeHuangguaPricing(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getHuangguaPricingVersion(): number {
  return liveVersion;
}

export function getCachedHuangguaLivePricing(): HuangguaLivePricingSnapshot | null {
  return liveSnapshot;
}

/** 仅供单元测试注入或重置实时定价快照。 */
export function setHuangguaLivePricingForTests(snapshot: HuangguaLivePricingSnapshot | null): void {
  liveSnapshot = snapshot;
  inflightFetch = null;
  notifyPricingListeners();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseHuangguaPricingResponse(payload: unknown): HuangguaLivePricingSnapshot | null {
  if (!isPlainRecord(payload) || payload.success !== true || !Array.isArray(payload.data)) {
    return null;
  }
  const models = new Map<string, LivePricingModelEntry>();
  for (const raw of payload.data) {
    if (!isPlainRecord(raw) || typeof raw.model_name !== 'string' || !raw.model_name.trim()) continue;
    models.set(raw.model_name, {
      modelName: raw.model_name,
      billingMode: typeof raw.billing_mode === 'string' ? raw.billing_mode : undefined,
      billingExpr: typeof raw.billing_expr === 'string' ? raw.billing_expr : undefined,
      modelPrice: typeof raw.model_price === 'number' && Number.isFinite(raw.model_price) ? raw.model_price : undefined,
      quotaType: typeof raw.quota_type === 'number' ? raw.quota_type : undefined,
      enableGroups: Array.isArray(raw.enable_groups)
        ? raw.enable_groups.filter((g): g is string => typeof g === 'string')
        : undefined,
    });
  }
  const groupRatio: Record<string, number> = {};
  if (isPlainRecord(payload.group_ratio)) {
    for (const [group, ratio] of Object.entries(payload.group_ratio)) {
      if (typeof ratio === 'number' && Number.isFinite(ratio) && ratio >= 0) {
        groupRatio[group] = ratio;
      }
    }
  }
  return { models, groupRatio, fetchedAt: Date.now() };
}

export async function refreshHuangguaLivePricing(force = false): Promise<HuangguaLivePricingSnapshot | null> {
  if (!force && liveSnapshot && Date.now() - liveSnapshot.fetchedAt < LIVE_CACHE_TTL_MS) {
    return liveSnapshot;
  }
  if (inflightFetch) return inflightFetch;
  inflightFetch = (async () => {
    try {
      const response = await corsSafeFetch(`${HUANGGUA_ORIGIN}/api/pricing`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return liveSnapshot;
      const parsed = parseHuangguaPricingResponse(await response.json());
      if (parsed) {
        liveSnapshot = parsed;
        notifyPricingListeners();
      }
      return liveSnapshot;
    } catch {
      return liveSnapshot;
    } finally {
      inflightFetch = null;
    }
  })();
  return inflightFetch;
}

export function useHuangguaLivePricing(enabled = true): number {
  const version = useSyncExternalStore(
    subscribeHuangguaPricing,
    getHuangguaPricingVersion,
    getHuangguaPricingVersion,
  );
  useEffect(() => {
    if (enabled) void refreshHuangguaLivePricing();
  }, [enabled]);
  return version;
}

function roundUsd(value: number): number {
  return Math.max(0, Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000);
}

/** 格式化美元金额：至少保留两位小数，最多保留六位有效小数（如 $0.06、$1.68、$0.1275、$3.00）。 */
export function formatHuangguaUsd(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  const clamped = roundUsd(value);
  const [intPart, fracPart = '000000'] = clamped.toFixed(6).split('.');
  const stripped = fracPart.replace(/0+$/, '');
  const decimals = stripped.length <= 2 ? stripped.padEnd(2, '0') : stripped;
  return `$${intPart}.${decimals}`;
}

function isHuangguaOriginUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'huanggua.my';
  } catch {
    return false;
  }
}

export function isHuangguaProviderConnection(
  providerConfigId: string | undefined,
  provider: unknown,
): boolean {
  if (!providerConfigId) return false;
  if (providerConfigId.startsWith(HUANGGUA_PROVIDER_PREFIX)) return true;
  if (isHuangguaManagedProvider(providerConfigId, provider)) return true;
  if (isPlainRecord(provider) && typeof provider.baseUrl === 'string') {
    return isHuangguaOriginUrl(provider.baseUrl);
  }
  return false;
}

function decodeModelTail(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function resolveHuangguaNodeModel(
  modelRef: string | undefined,
  providerId: string | undefined,
  config?: Pick<AppConfig, 'providers' | 'generalModels'>,
): ResolvedHuangguaNodeModel | null {
  if (!modelRef) return null;
  const trimmed = modelRef.replace(/^general\//, '');

  const generalMatch = config?.generalModels?.find((item: GeneralModelConfig) => (
    item.id === trimmed
    || (providerId && providerId !== 'general' && item.providerConfigId === providerId && item.modelId === modelRef.replace(`${providerId}/`, ''))
  ));
  if (generalMatch) {
    const provider = config?.providers?.[generalMatch.providerConfigId];
    if (!isHuangguaProviderConnection(generalMatch.providerConfigId, provider)) return null;
    return {
      modelId: generalMatch.modelId,
      providerConfigId: generalMatch.providerConfigId,
      imageCapability: generalMatch.imageCapability,
      videoCapability: generalMatch.videoCapability,
    };
  }

  const accountMatch = /^(huanggua-account-(?:image|video|text))\/(.+)$/.exec(trimmed);
  if (accountMatch) {
    return {
      modelId: decodeModelTail(accountMatch[2]),
      providerConfigId: accountMatch[1],
    };
  }

  if (providerId && providerId !== 'general') {
    const provider = config?.providers?.[providerId];
    if (isHuangguaProviderConnection(providerId, provider)) {
      const modelId = modelRef.startsWith(`${providerId}/`)
        ? modelRef.slice(providerId.length + 1)
        : modelRef;
      return { modelId, providerConfigId: providerId };
    }
  }
  return null;
}

function resolveGroupRatio(
  entry: LivePricingModelEntry | undefined,
  kind: 'image' | 'video',
  snapshot: HuangguaLivePricingSnapshot | null | undefined,
): number {
  if (!entry?.enableGroups?.length || !snapshot) return 1;
  const preferred = kind === 'image'
    ? ['g图片模型', '图片模型', 'Gemini生图', 'default']
    : ['g视频模型', '视频模型', 'default'];
  for (const group of preferred) {
    if (entry.enableGroups.includes(group) && snapshot.groupRatio[group] !== undefined) {
      return snapshot.groupRatio[group];
    }
  }
  const ratios = entry.enableGroups
    .map((g) => snapshot.groupRatio[g])
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  return ratios.length ? Math.min(...ratios) : 1;
}

function resolveGrsaiCreditRate(
  modelId: string,
  kind: 'image' | 'video',
  snapshot: HuangguaLivePricingSnapshot | null | undefined,
): number | null {
  const entry = snapshot?.models.get(modelId);
  if (!entry) return catalog.defaultGrsaiRate;
  if (entry.billingMode === 'tiered_expr' && entry.billingExpr) {
    const match = GRSAI_EXPR_RE.exec(entry.billingExpr);
    if (!match) return null;
    return Number(match[1]) * resolveGroupRatio(entry, kind, snapshot);
  }
  return catalog.defaultGrsaiRate * resolveGroupRatio(entry, kind, snapshot);
}

function resolveCatcodeMultiplier(
  modelId: string,
  kind: 'image' | 'video',
  snapshot: HuangguaLivePricingSnapshot | null | undefined,
): number | null {
  const entry = snapshot?.models.get(modelId);
  if (!entry) return catalog.defaultCatcodeFactor / 1_000_000;
  if (entry.billingMode === 'tiered_expr' && entry.billingExpr) {
    const match = CATCODE_EXPR_RE.exec(entry.billingExpr);
    if (!match) return null;
    return (Number(match[1]) * resolveGroupRatio(entry, kind, snapshot)) / 1_000_000;
  }
  return (catalog.defaultCatcodeFactor * resolveGroupRatio(entry, kind, snapshot)) / 1_000_000;
}

function resolveDynamicImageUnitUsd(
  modelId: string,
  resolution: string,
  snapshot: HuangguaLivePricingSnapshot | null | undefined,
): { minUsd: number; maxUsd: number; selectedUsd: number } | null {
  const entry = snapshot?.models.get(modelId);
  if (!entry) return null;
  const ratio = resolveGroupRatio(entry, 'image', snapshot);
  if (entry.billingMode === 'tiered_expr' && entry.billingExpr) {
    const fixedMatch = NATIVE_IMAGE_EXPR_RE.exec(entry.billingExpr);
    if (fixedMatch) {
      const price = Number(fixedMatch[1]) * ratio;
      return { minUsd: price, maxUsd: price, selectedUsd: price };
    }
    const geminiMatch = GEMINI_TIERED_IMAGE_RE.exec(entry.billingExpr);
    if (geminiMatch) {
      const p4k = Number(geminiMatch[1]) * ratio;
      const p2k = Number(geminiMatch[2]) * ratio;
      const p1k = Number(geminiMatch[3]) * ratio;
      const upper = resolution.toUpperCase();
      const selectedUsd = upper === '4K' ? p4k : upper === '2K' ? p2k : p1k;
      return {
        minUsd: Math.min(p1k, p2k, p4k),
        maxUsd: Math.max(p1k, p2k, p4k),
        selectedUsd,
      };
    }
  }
  if (entry.quotaType === 1 && typeof entry.modelPrice === 'number' && entry.modelPrice >= 0) {
    const price = entry.modelPrice * ratio;
    return { minUsd: price, maxUsd: price, selectedUsd: price };
  }
  return null;
}

export function getHuangguaModelTariffSummary(
  modelId: string,
  unitLabels: { perImage?: string; perSecond?: string; perTask?: string } = {},
  snapshot: HuangguaLivePricingSnapshot | null | undefined = liveSnapshot,
): HuangguaTariffSummary | null {
  const perImage = unitLabels.perImage ?? '/张';
  const perSecond = unitLabels.perSecond ?? '/秒';
  const perTask = unitLabels.perTask ?? '/次';

  const grsai = catalog.grsai[modelId];
  if (grsai) {
    const rate = resolveGrsaiCreditRate(modelId, grsai.kind, snapshot);
    if (rate === null) return null;
    const usd = grsai.credits * rate;
    const unit = grsai.kind === 'image' ? 'image' : 'second';
    return {
      unitBadge: `${formatHuangguaUsd(usd)}${unit === 'image' ? perImage : perSecond}`,
      minUsd: usd,
      maxUsd: usd,
      unit,
    };
  }

  const catImg = catalog.catcodeImages[modelId];
  if (catImg) {
    const mult = resolveCatcodeMultiplier(modelId, 'image', snapshot);
    if (mult === null) return null;
    const values = Object.values(catImg.prices).map((p) => p * mult);
    if (!values.length) return null;
    const minUsd = Math.min(...values);
    const maxUsd = Math.max(...values);
    const range = Math.abs(maxUsd - minUsd) < 1e-9
      ? formatHuangguaUsd(minUsd)
      : `${formatHuangguaUsd(minUsd)}~${formatHuangguaUsd(maxUsd)}`;
    return { unitBadge: `${range}${perImage}`, minUsd, maxUsd, unit: 'image' };
  }

  const catVid = catalog.catcodeVideos[modelId];
  if (catVid) {
    const mult = resolveCatcodeMultiplier(modelId, 'video', snapshot);
    if (mult === null || !catVid.variants.length) return null;
    const values = catVid.variants.map((v) => v.price * mult);
    const minUsd = Math.min(...values);
    const maxUsd = Math.max(...values);
    const isTask = catVid.pricingMode === 'task';
    const range = Math.abs(maxUsd - minUsd) < 1e-9
      ? formatHuangguaUsd(minUsd)
      : `${formatHuangguaUsd(minUsd)}~${formatHuangguaUsd(maxUsd)}`;
    return {
      unitBadge: `${range}${isTask ? perTask : perSecond}`,
      minUsd,
      maxUsd,
      unit: isTask ? 'task' : 'second',
    };
  }

  const dynamicImg = resolveDynamicImageUnitUsd(modelId, '1K', snapshot);
  if (dynamicImg) {
    const isVideoLike = /video|h3|seedance|kling|wan/i.test(modelId) && !/image/i.test(modelId);
    const range = Math.abs(dynamicImg.maxUsd - dynamicImg.minUsd) < 1e-9
      ? formatHuangguaUsd(dynamicImg.minUsd)
      : `${formatHuangguaUsd(dynamicImg.minUsd)}~${formatHuangguaUsd(dynamicImg.maxUsd)}`;
    return {
      unitBadge: `${range}${isVideoLike ? perTask : perImage}`,
      minUsd: dynamicImg.minUsd,
      maxUsd: dynamicImg.maxUsd,
      unit: isVideoLike ? 'task' : 'image',
    };
  }

  return null;
}

export function quoteHuangguaImageCost(input: {
  modelId: string;
  resolution?: string;
  quality?: string;
  count?: number;
  imageCapability?: ImageModelCapability;
}, snapshot: HuangguaLivePricingSnapshot | null | undefined = liveSnapshot): HuangguaMediaCostQuote | null {
  const count = input.imageCapability?.supportsBatch === false
    ? 1
    : Math.max(1, Math.floor(input.count ?? 1));
  const supportedResolutions = input.imageCapability?.resolutions;
  const rawRes = input.resolution?.trim();
  const effectiveResolution = supportedResolutions?.length
    ? (supportedResolutions.find((r) => r.toLowerCase() === rawRes?.toLowerCase())
      ?? input.imageCapability?.defaultResolution
      ?? supportedResolutions[0])
    : (rawRes || '1K');
  const effectiveQuality = (input.quality || input.imageCapability?.defaultQuality || 'medium').toLowerCase();

  const grsai = catalog.grsai[input.modelId];
  if (grsai && grsai.kind === 'image') {
    const rate = resolveGrsaiCreditRate(input.modelId, 'image', snapshot);
    if (rate === null) return null;
    const unitUsd = roundUsd(grsai.credits * rate);
    const amountUsd = roundUsd(unitUsd * count);
    const unitFormatted = `${formatHuangguaUsd(unitUsd)}/张`;
    return {
      amountUsd,
      formattedAmount: formatHuangguaUsd(amountUsd),
      pricingKind: 'fixed_image',
      unitFormatted,
      breakdown: count > 1 ? `${unitFormatted} × ${count}张` : unitFormatted,
    };
  }

  const catImg = catalog.catcodeImages[input.modelId];
  if (catImg) {
    const mult = resolveCatcodeMultiplier(input.modelId, 'image', snapshot);
    if (mult === null) return null;
    const resUpper = effectiveResolution.toUpperCase();
    const matchedCredits = catImg.prices[`${resUpper}/${effectiveQuality}`]
      ?? catImg.prices[`${resUpper}/medium`]
      ?? catImg.prices[`${resUpper}/auto`]
      ?? Object.entries(catImg.prices).find(([key]) => key.toUpperCase().startsWith(`${resUpper}/`))?.[1]
      ?? Object.values(catImg.prices)[0];
    if (matchedCredits === undefined) return null;
    const unitUsd = roundUsd(matchedCredits * mult);
    const amountUsd = roundUsd(unitUsd * count);
    const unitFormatted = `${formatHuangguaUsd(unitUsd)}/张`;
    return {
      amountUsd,
      formattedAmount: formatHuangguaUsd(amountUsd),
      pricingKind: 'fixed_image',
      unitFormatted,
      breakdown: count > 1 ? `${unitFormatted} × ${count}张` : `${resUpper} · ${unitFormatted}`,
    };
  }

  const dynamicImg = resolveDynamicImageUnitUsd(input.modelId, effectiveResolution, snapshot);
  if (dynamicImg) {
    const unitUsd = roundUsd(dynamicImg.selectedUsd);
    const amountUsd = roundUsd(unitUsd * count);
    const unitFormatted = `${formatHuangguaUsd(unitUsd)}/张`;
    return {
      amountUsd,
      formattedAmount: formatHuangguaUsd(amountUsd),
      pricingKind: 'fixed_image',
      unitFormatted,
      breakdown: count > 1 ? `${unitFormatted} × ${count}张` : unitFormatted,
    };
  }

  return null;
}

export function quoteHuangguaVideoCost(input: {
  modelId: string;
  resolution?: string;
  durationSeconds?: number;
  referenceImageCount?: number;
  referenceVideoCount?: number;
  videoCapability?: VideoModelCapability;
}, snapshot: HuangguaLivePricingSnapshot | null | undefined = liveSnapshot): HuangguaMediaCostQuote | null {
  const cap = input.videoCapability;
  const rawDuration = input.durationSeconds ?? cap?.defaultDuration ?? 5;
  const rawResolution = (input.resolution || cap?.defaultResolution || '').toLowerCase();

  const grsai = catalog.grsai[input.modelId];
  if (grsai && grsai.kind === 'video') {
    const rate = resolveGrsaiCreditRate(input.modelId, 'video', snapshot);
    if (rate === null) return null;
    const duration = rawDuration > 0 ? Math.round(rawDuration) : (cap?.defaultDuration ?? 5);
    const unitUsd = roundUsd(grsai.credits * rate);
    const amountUsd = roundUsd(unitUsd * duration);
    const unitFormatted = `${formatHuangguaUsd(unitUsd)}/秒`;
    return {
      amountUsd,
      formattedAmount: formatHuangguaUsd(amountUsd),
      pricingKind: 'per_second',
      unitFormatted,
      breakdown: `${unitFormatted} × ${duration}s`,
    };
  }

  const catVid = catalog.catcodeVideos[input.modelId];
  if (catVid && catVid.variants.length > 0) {
    const mult = resolveCatcodeMultiplier(input.modelId, 'video', snapshot);
    if (mult === null) return null;
    const variant = catVid.variants.find((v) => v.resolution.toLowerCase() === rawResolution)
      ?? catVid.variants[0];
    const isTask = catVid.pricingMode === 'task';
    const isAutoDuration = !isTask && rawDuration < 0;
    const duration = isTask
      ? 1
      : isAutoDuration
        ? Math.max(...(variant.durations.length ? variant.durations : [5]))
        : Math.max(1, Math.round(rawDuration));

    let micro = variant.price * (isTask ? 1 : duration);
    const refVideos = Math.max(0, Math.floor(input.referenceVideoCount ?? 0));
    const refImages = Math.max(0, Math.floor(input.referenceImageCount ?? 0));
    if (catVid.pricingMode === 'video_token' && refVideos > 0) {
      micro *= 2;
    }
    if (refVideos > 0 && (catVid.referenceVideoModelPrice || catVid.pricingMode === 'second')) {
      micro += variant.price * refVideos * 300;
    }
    const extraImages = Math.max(0, refImages - catVid.includedImages);
    if (extraImages > 0 && catVid.extraImagePrice > 0) {
      micro += extraImages * catVid.extraImagePrice;
    }

    const amountUsd = roundUsd(micro * mult);
    const baseUnitUsd = roundUsd(variant.price * mult);
    const unitFormatted = `${formatHuangguaUsd(baseUnitUsd)}${isTask ? '/次' : '/秒'}`;
    const extras: string[] = [];
    if (isTask) {
      extras.push(`${variant.resolution} · 固定 ${unitFormatted}`);
    } else {
      extras.push(`${variant.resolution} · ${unitFormatted} × ${isAutoDuration ? `最高${duration}s` : `${duration}s`}`);
    }
    if (extraImages > 0 && catVid.extraImagePrice > 0) {
      extras.push(`超额参考图 ${extraImages}张`);
    }
    if (refVideos > 0) {
      extras.push(`含参考视频 ${refVideos}段`);
    }
    return {
      amountUsd,
      formattedAmount: formatHuangguaUsd(amountUsd),
      pricingKind: isTask ? 'fixed_task' : 'per_second',
      unitFormatted,
      breakdown: extras.join(' + '),
      isAutoDuration,
    };
  }

  const entry = snapshot?.models.get(input.modelId);
  if (entry?.quotaType === 1 && typeof entry.modelPrice === 'number' && entry.modelPrice >= 0) {
    const amountUsd = roundUsd(entry.modelPrice * resolveGroupRatio(entry, 'video', snapshot));
    const unitFormatted = `${formatHuangguaUsd(amountUsd)}/次`;
    return {
      amountUsd,
      formattedAmount: formatHuangguaUsd(amountUsd),
      pricingKind: 'fixed_task',
      unitFormatted,
      breakdown: `固定 ${unitFormatted}`,
    };
  }

  return null;
}

function countNodeMediaReferences(data: BaseNodeData): { images: number; videos: number } {
  const refs = data.videoReferences ?? [];
  const videos = refs.filter((item) => item.mediaKind === 'video').length;
  const explicitImages = refs.filter((item) => (
    item.mediaKind !== 'video'
    && item.mediaKind !== 'audio'
    && item.role !== 'reference_audio'
  )).length;
  const promptMentions = new Set(
    Array.from((data.prompt ?? '').matchAll(/@node\{([^|}]+)\|/g), (m) => m[1]),
  );
  return {
    images: Math.max(explicitImages, promptMentions.size),
    videos,
  };
}

export function quoteHuangguaNodeCost(
  data: BaseNodeData,
  config?: Pick<AppConfig, 'providers' | 'generalModels'>,
  snapshot: HuangguaLivePricingSnapshot | null | undefined = liveSnapshot,
): HuangguaMediaCostQuote | null {
  if (data.workflowId || !data.model || !['ai-image', 'ai-video'].includes(data.type)) {
    return null;
  }
  const resolved = resolveHuangguaNodeModel(data.model, data.provider, config);
  if (!resolved) return null;

  if (data.type === 'ai-image') {
    return quoteHuangguaImageCost({
      modelId: resolved.modelId,
      resolution: typeof data.imageSize === 'string' ? data.imageSize : undefined,
      quality: data.imageQuality,
      count: typeof data.batchCount === 'number' ? data.batchCount : 1,
      imageCapability: resolved.imageCapability,
    }, snapshot);
  }

  const mediaCounts = countNodeMediaReferences(data);
  return quoteHuangguaVideoCost({
    modelId: resolved.modelId,
    resolution: typeof data.seedanceResolution === 'string' ? data.seedanceResolution : undefined,
    durationSeconds: typeof data.seedanceDuration === 'number' ? data.seedanceDuration : undefined,
    referenceImageCount: mediaCounts.images,
    referenceVideoCount: mediaCounts.videos,
    videoCapability: resolved.videoCapability,
  }, snapshot);
}
