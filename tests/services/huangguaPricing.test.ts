import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig, BaseNodeData, GeneralModelConfig } from '../../src/types';
import { getGeneralModelGroups } from '../../src/components/nodes/shared/defaultModels';
import { buildHuangguaConnections } from '../../src/services/huangguaModelConnectionService';
import {
  formatHuangguaUsd,
  getHuangguaModelTariffSummary,
  parseHuangguaPricingResponse,
  quoteHuangguaNodeCost,
  setHuangguaLivePricingForTests,
} from '../../src/services/billing/huangguaPricing';

function createHuangguaTestConfig(): {
  config: Pick<AppConfig, 'providers' | 'generalModels'>;
  generalModels: GeneralModelConfig[];
} {
  const providers = buildHuangguaConnections([
    {
      category: 'image',
      apiKey: 'sk-test-placeholder',
      models: [
        'grsai-gpt-image-2.6',
        'grsai-nano-banana-fast',
        'catcode-image-Nano Banana Pro',
        'catcode-image-Seedream 5.0 Pro',
      ],
    },
    {
      category: 'video',
      apiKey: 'sk-test-placeholder',
      models: [
        'grsai-minimax-h3-768p',
        'catcode-sd-2.5-gz',
        'catcode-Seedance-2.0-官转',
        'catcode-Minimax H3',
      ],
    },
  ]);
  const generalModels: GeneralModelConfig[] = Object.entries(providers).flatMap(([providerConfigId, provider]) => (
    (provider.selectedModels ?? []).map((model) => ({
      id: `${providerConfigId}/${encodeURIComponent(model.id)}`,
      name: model.name,
      modelId: model.id,
      category: model.category,
      providerConfigId,
      imageCapability: model.imageCapability,
      videoCapability: model.videoCapability,
    }))
  ));
  return {
    config: { providers, generalModels },
    generalModels,
  };
}

describe('huangguaPricing', () => {
  afterEach(() => {
    setHuangguaLivePricingForTests(null);
  });

  it('formats USD amounts with 2 to 6 significant decimal digits', () => {
    expect(formatHuangguaUsd(0.06)).toBe('$0.06');
    expect(formatHuangguaUsd(1.68)).toBe('$1.68');
    expect(formatHuangguaUsd(3)).toBe('$3.00');
    expect(formatHuangguaUsd(0.044)).toBe('$0.044');
    expect(formatHuangguaUsd(0.1275)).toBe('$0.1275');
    expect(formatHuangguaUsd(13.875)).toBe('$13.875');
  });

  it('computes exact GrsAI video and image charges matching huanggua.my', () => {
    const { config } = createHuangguaTestConfig();

    const h3Quote = quoteHuangguaNodeCost({
      label: '视频生成',
      type: 'ai-video',
      provider: 'general',
      model: 'general/huanggua-account-video/grsai-minimax-h3-768p',
      seedanceResolution: '768p',
      seedanceDuration: 12,
      seedanceRatio: '3:4',
    } as BaseNodeData, config);
    expect(h3Quote).toMatchObject({
      amountUsd: 1.68,
      formattedAmount: '$1.68',
      pricingKind: 'per_second',
      unitFormatted: '$0.14/秒',
      breakdown: '$0.14/秒 × 12s',
    });

    const gptImgQuote = quoteHuangguaNodeCost({
      label: '图片生成',
      type: 'ai-image',
      provider: 'general',
      model: 'general/huanggua-account-image/grsai-gpt-image-2.6',
      imageSize: '2K',
    } as BaseNodeData, config);
    expect(gptImgQuote).toMatchObject({
      amountUsd: 0.06,
      formattedAmount: '$0.06',
      pricingKind: 'fixed_image',
      unitFormatted: '$0.06/张',
    });

    const bananaFastQuote = quoteHuangguaNodeCost({
      label: '图片生成',
      type: 'ai-image',
      provider: 'general',
      model: 'general/huanggua-account-image/grsai-nano-banana-fast',
    } as BaseNodeData, config);
    expect(bananaFastQuote?.formattedAmount).toBe('$0.044');
  });

  it('computes Catcode image resolution tiers, fixed-task videos, and Seedance holds', () => {
    const { config } = createHuangguaTestConfig();

    const seedream1k = quoteHuangguaNodeCost({
      label: '图片生成',
      type: 'ai-image',
      provider: 'general',
      model: `general/huanggua-account-image/${encodeURIComponent('catcode-image-Seedream 5.0 Pro')}`,
      imageSize: '1K',
    } as BaseNodeData, config);
    expect(seedream1k?.formattedAmount).toBe('$0.135');

    const fixedTaskVideo = quoteHuangguaNodeCost({
      label: '视频生成',
      type: 'ai-video',
      provider: 'general',
      model: 'general/huanggua-account-video/catcode-sd-2.5-gz',
      seedanceDuration: 10,
      seedanceResolution: '720p',
    } as BaseNodeData, config);
    expect(fixedTaskVideo).toMatchObject({
      amountUsd: 9.75,
      formattedAmount: '$9.75',
      pricingKind: 'fixed_task',
    });

    const seedance720 = quoteHuangguaNodeCost({
      label: '视频生成',
      type: 'ai-video',
      provider: 'general',
      model: `general/huanggua-account-video/${encodeURIComponent('catcode-Seedance-2.0-官转')}`,
      seedanceResolution: '720p',
      seedanceDuration: 5,
    } as BaseNodeData, config);
    expect(seedance720?.formattedAmount).toBe('$5.55');

    const seedanceAuto = quoteHuangguaNodeCost({
      label: '视频生成',
      type: 'ai-video',
      provider: 'general',
      model: `general/huanggua-account-video/${encodeURIComponent('catcode-Seedance-2.0-官转')}`,
      seedanceResolution: '720p',
      seedanceDuration: -1,
    } as BaseNodeData, config);
    expect(seedanceAuto).toMatchObject({
      formattedAmount: '$16.65',
      isAutoDuration: true,
    });

    const minimaxExtraImgs = quoteHuangguaNodeCost({
      label: '视频生成',
      type: 'ai-video',
      provider: 'general',
      model: `general/huanggua-account-video/${encodeURIComponent('catcode-Minimax H3')}`,
      seedanceResolution: '768p',
      seedanceDuration: 5,
      prompt: '@node{n1|图1} @node{n2|图2} @node{n3|图3} @node{n4|图4} @node{n5|图5} @node{n6|图6} @node{n7|图7}',
    } as BaseNodeData, config);
    // 5s * $0.18 + (7 - 5) * $0.15 = $0.90 + $0.30 = $1.20
    expect(minimaxExtraImgs?.formattedAmount).toBe('$1.20');
  });

  it('syncs dynamic multipliers and group_ratio from /api/pricing', () => {
    const { config } = createHuangguaTestConfig();
    const parsed = parseHuangguaPricingResponse({
      success: true,
      data: [
        {
          model_name: 'grsai-minimax-h3-768p',
          billing_mode: 'tiered_expr',
          billing_expr: 'tier("grsai", u("credits") * 0.0001)',
          enable_groups: ['g视频模型'],
        },
      ],
      group_ratio: {
        'g视频模型': 0.5,
      },
    });
    expect(parsed).not.toBeNull();
    setHuangguaLivePricingForTests(parsed);

    const discounted = quoteHuangguaNodeCost({
      label: '视频生成',
      type: 'ai-video',
      provider: 'general',
      model: 'general/huanggua-account-video/grsai-minimax-h3-768p',
      seedanceResolution: '768p',
      seedanceDuration: 10,
    } as BaseNodeData, config);
    expect(discounted?.formattedAmount).toBe('$0.70');
  });

  it('returns null for non-Huanggua providers and exposes unit badges in model menus', () => {
    const { config, generalModels } = createHuangguaTestConfig();

    const thirdParty = quoteHuangguaNodeCost({
      label: '图片生成',
      type: 'ai-image',
      provider: 'apimart',
      model: 'apimart/gpt-image-2',
    } as BaseNodeData, config);
    expect(thirdParty).toBeNull();

    expect(getHuangguaModelTariffSummary('grsai-minimax-h3-768p')?.unitBadge).toBe('$0.14/秒');
    expect(getHuangguaModelTariffSummary('catcode-image-Seedream 5.0 Pro')?.unitBadge).toBe('$0.135~$0.15/张');

    const videoGroups = getGeneralModelGroups(
      generalModels,
      { providers: config.providers },
      'ai-video',
    );
    const descriptions = videoGroups.flatMap((g) => g.models.map((m) => [m.label, m.description]));
    expect(descriptions).toContainEqual(['GrsAI · minimax-h3 · 768p', '$0.14/秒']);
    expect(descriptions).toContainEqual(['sd-2.5-gz', '$9.75/次']);
  });
});
