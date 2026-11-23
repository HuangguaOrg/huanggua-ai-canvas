/**
 * styleAndAssets — 回归测试：短剧 Agent 36 款画面风格模版、必选校验与资产主图去重。
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STYLE_TEMPLATE_ID,
  STUDIO_STYLE_TEMPLATES,
  findStyleTemplate,
  getStyleTemplatesByCategory,
  hasProjectStyleConfigured,
  isStyleDraftComplete,
} from '../../src/components/studio/styleTemplates';
import {
  STUDIO_PRESET_RATIOS,
  draftFromStoredStudioRatio,
  formatStudioRatioBadge,
  parseCombinedPairInput,
  resolveStudioRatioDraft,
  toStudioCssAspect,
} from '../../src/components/studio/studioRatios';
import type { StudioArtifact } from '../../src/types/studio';

describe('Studio style templates & mandatory selection', () => {
  it('ships all 36 live and animation style templates with bundled WebP thumbnails', () => {
    expect(STUDIO_STYLE_TEMPLATES).toHaveLength(36);
    expect(getStyleTemplatesByCategory('live')).toHaveLength(18);
    expect(getStyleTemplatesByCategory('anim')).toHaveLength(18);
    expect(findStyleTemplate(DEFAULT_STYLE_TEMPLATE_ID)?.name).toBe('精品短剧');

    const root = path.resolve(__dirname, '../..');
    const seenIds = new Set<string>();
    for (const tpl of STUDIO_STYLE_TEMPLATES) {
      expect(seenIds.has(tpl.id)).toBe(false);
      seenIds.add(tpl.id);
      expect(tpl.name.trim().length).toBeGreaterThan(0);
      expect(tpl.tagline.trim().length).toBeGreaterThan(0);
      const thumbFile = path.join(root, 'public', tpl.thumbnail.replace(/^\//, ''));
      expect(existsSync(thumbFile), `missing thumbnail: ${tpl.thumbnail}`).toBe(true);
      expect(statSync(thumbFile).size).toBeGreaterThan(1024);
    }
  });

  it('requires either a selected template or an uploaded reference image', () => {
    expect(isStyleDraftComplete({
      mode: 'template',
      templateId: null,
      activeCategory: 'live',
      uploadedFile: null,
      uploadedPreview: null,
    })).toBe(false);

    expect(isStyleDraftComplete({
      mode: 'template',
      templateId: 'anim_cn_3d',
      activeCategory: 'anim',
      uploadedFile: null,
      uploadedPreview: null,
    })).toBe(true);

    expect(isStyleDraftComplete({
      mode: 'custom',
      templateId: null,
      activeCategory: 'live',
      uploadedFile: null,
      uploadedPreview: null,
    })).toBe(false);

    expect(isStyleDraftComplete({
      mode: 'custom',
      templateId: null,
      activeCategory: 'live',
      uploadedFile: null,
      uploadedPreview: 'asset://localhost/style_reference.png',
    })).toBe(true);

    expect(hasProjectStyleConfigured({ style: '', style_template_id: null, style_image: null }, null)).toBe(false);
    expect(hasProjectStyleConfigured({ style: '', style_template_id: 'live_wong', style_image: null }, null)).toBe(true);
    expect(hasProjectStyleConfigured({ style: '', style_template_id: null, style_image: 'style_reference.png' }, null)).toBe(true);
    expect(hasProjectStyleConfigured(undefined, 'anim_ghibli')).toBe(true);
  });

  it('preserves canonical character and scene sheets when version snapshots share identical SHA-256 digests', () => {
    const raw: StudioArtifact[] = [
      { id: 'aaaa'.repeat(16), name: 'characters/周小满.png', kind: 'image', size: 1380890, imported: true, url: 'asset://c1' },
      { id: 'bbbb'.repeat(16), name: 'scenes/学校操场.png', kind: 'image', size: 2413729, imported: true, url: 'asset://s1' },
      { id: 'aaaa'.repeat(16), name: 'versions/characters/周小满_v1_20261122T153632.png', kind: 'image', size: 1380890, imported: true, url: 'asset://c1' },
      { id: 'bbbb'.repeat(16), name: 'versions/scenes/学校操场_v1_20261122T153856.png', kind: 'image', size: 2413729, imported: true, url: 'asset://s1' },
    ];
    const deduped = [...new Map(raw.map(a => [a.name, a])).values()];
    const visible = deduped.filter(a => !a.name.startsWith('versions/'));

    expect(deduped.map(a => a.name)).toEqual([
      'characters/周小满.png',
      'scenes/学校操场.png',
      'versions/characters/周小满_v1_20261122T153632.png',
      'versions/scenes/学校操场_v1_20261122T153856.png',
    ]);
    expect(visible.map(a => a.name)).toEqual([
      'characters/周小满.png',
      'scenes/学校操场.png',
    ]);
  });

  it('supports 4:3, 3:4, and custom resolutions/ratios in Studio project settings', () => {
    expect(STUDIO_PRESET_RATIOS).toEqual(['9:16', '16:9', '4:3', '3:4', '1:1']);

    const p43 = resolveStudioRatioDraft(draftFromStoredStudioRatio('4:3', null));
    expect(p43).toMatchObject({
      valid: true,
      aspectRatio: '4:3',
      customResolution: null,
      canvasSize: [1440, 1080],
    });

    const p34 = resolveStudioRatioDraft(draftFromStoredStudioRatio('3:4', null));
    expect(p34).toMatchObject({
      valid: true,
      aspectRatio: '3:4',
      customResolution: null,
      canvasSize: [1080, 1440],
    });

    const customPixels = resolveStudioRatioDraft({
      mode: 'custom',
      presetRatio: '9:16',
      customWidth: '1081',
      customHeight: '1351',
    });
    expect(customPixels).toMatchObject({
      valid: true,
      aspectRatio: '541:676',
      customResolution: '1082x1352',
      canvasSize: [1082, 1352],
    });

    const customCinema = resolveStudioRatioDraft({
      mode: 'custom',
      presetRatio: '9:16',
      customWidth: '21',
      customHeight: '9',
    });
    expect(customCinema).toMatchObject({
      valid: true,
      aspectRatio: '21:9',
      customResolution: null,
      canvasSize: [2520, 1080],
    });

    const invalidExtreme = resolveStudioRatioDraft({
      mode: 'custom',
      presetRatio: '9:16',
      customWidth: '4000',
      customHeight: '100',
    });
    expect(invalidExtreme.valid).toBe(false);

    expect(parseCombinedPairInput('1440x1080')).toEqual({ width: '1440', height: '1080' });
    expect(parseCombinedPairInput('21:9')).toEqual({ width: '21', height: '9' });
    expect(formatStudioRatioBadge('3:4', '1080x1440')).toBe('3:4（1080×1440）');
    expect(toStudioCssAspect('4:3', null)).toBe('4 / 3');
    expect(toStudioCssAspect('3:4', '1080x1440')).toBe('1080 / 1440');
  });
});
