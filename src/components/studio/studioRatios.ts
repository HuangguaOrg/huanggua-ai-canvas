export const STUDIO_PRESET_RATIOS = ['9:16', '16:9', '4:3', '3:4', '1:1'] as const;
export const STUDIO_CUSTOM_RATIO_OPTION = '__custom__';

export const STUDIO_RATIO_SELECT_OPTIONS = [
  { value: '9:16', label: '9:16（竖屏 · 1080×1920）' },
  { value: '16:9', label: '16:9（横屏 · 1920×1080）' },
  { value: '4:3', label: '4:3（横屏 · 1440×1080）' },
  { value: '3:4', label: '3:4（竖屏 · 1080×1440）' },
  { value: '1:1', label: '1:1（方形 · 1080×1080）' },
  { value: STUDIO_CUSTOM_RATIO_OPTION, label: '自定义分辨率 / 比例…' },
] as const;

export const STUDIO_CUSTOM_QUICK_PRESETS: ReadonlyArray<{ label: string; width: string; height: string }> = [
  { label: '1080×1440 (3:4)', width: '1080', height: '1440' },
  { label: '1440×1080 (4:3)', width: '1440', height: '1080' },
  { label: '1080×1350 (4:5)', width: '1080', height: '1350' },
  { label: '2520×1080 (21:9)', width: '2520', height: '1080' },
  { label: '21:9 电影宽屏', width: '21', height: '9' },
  { label: '3:2 横构图', width: '3', height: '2' },
  { label: '2:3 竖构图', width: '2', height: '3' },
];

export interface StudioRatioDraft {
  mode: 'preset' | 'custom';
  presetRatio: string;
  customWidth: string;
  customHeight: string;
}

export interface ResolvedStudioRatio {
  valid: boolean;
  aspectRatio: string;
  customResolution: string | null;
  canvasSize: [number, number];
  displayLabel: string;
  error?: string;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1;
}

export function canonicalAspectRatio(width: number, height: number): string {
  const divisor = gcd(width, height);
  const rw = Math.round(width / divisor);
  const rh = Math.round(height / divisor);
  if (rw === 7 && rh === 3) return '21:9';
  if (rw === 3 && rh === 7) return '9:21';
  return `${rw}:${rh}`;
}

export function defaultCanvasForAspectRatio(aspectRatio: string): [number, number] {
  const parts = aspectRatio.split(':').map(Number);
  const w = parts[0] && parts[0] > 0 ? parts[0] : 9;
  const h = parts[1] && parts[1] > 0 ? parts[1] : 16;
  if (w >= h) {
    return [Math.max(2, Math.round((1080 * w) / h / 2) * 2), 1080];
  }
  return [1080, Math.max(2, Math.round((1080 * h) / w / 2) * 2)];
}

export function draftFromStoredStudioRatio(
  aspectRatio?: string | null,
  customResolution?: string | null,
): StudioRatioDraft {
  const resMatch = customResolution ? /^(\d{2,5})x(\d{2,5})$/i.exec(customResolution.trim()) : null;
  if (resMatch) {
    return {
      mode: 'custom',
      presetRatio: '9:16',
      customWidth: resMatch[1],
      customHeight: resMatch[2],
    };
  }
  const normalized = aspectRatio?.trim() || '9:16';
  if ((STUDIO_PRESET_RATIOS as readonly string[]).includes(normalized)) {
    return {
      mode: 'preset',
      presetRatio: normalized,
      customWidth: '1080',
      customHeight: '1440',
    };
  }
  const ratioMatch = /^(\d{1,5}):(\d{1,5})$/.exec(normalized);
  if (ratioMatch) {
    return {
      mode: 'custom',
      presetRatio: '9:16',
      customWidth: ratioMatch[1],
      customHeight: ratioMatch[2],
    };
  }
  return {
    mode: 'preset',
    presetRatio: '9:16',
    customWidth: '1080',
    customHeight: '1440',
  };
}

export function parseCombinedPairInput(raw: string): { width: string; height: string } | null {
  const match = /^\s*(\d{1,5})\s*[:xX×*／/]\s*(\d{1,5})\s*$/.exec(raw);
  if (!match) return null;
  return { width: match[1], height: match[2] };
}

export function resolveStudioRatioDraft(draft: StudioRatioDraft): ResolvedStudioRatio {
  if (draft.mode === 'preset') {
    const ratio = (STUDIO_PRESET_RATIOS as readonly string[]).includes(draft.presetRatio)
      ? draft.presetRatio
      : '9:16';
    const canvasSize = defaultCanvasForAspectRatio(ratio);
    return {
      valid: true,
      aspectRatio: ratio,
      customResolution: null,
      canvasSize,
      displayLabel: ratio,
    };
  }

  const wRaw = Number(draft.customWidth.trim());
  const hRaw = Number(draft.customHeight.trim());
  if (!Number.isInteger(wRaw) || !Number.isInteger(hRaw) || wRaw <= 0 || hRaw <= 0) {
    return {
      valid: false,
      aspectRatio: '9:16',
      customResolution: null,
      canvasSize: [1080, 1920],
      displayLabel: '自定义',
      error: '请填写正整数宽度与高度（如 1080 × 1440 或比例 21 × 9）。',
    };
  }
  const ratioFloat = wRaw / hRaw;
  if (ratioFloat < 0.125 || ratioFloat > 8) {
    return {
      valid: false,
      aspectRatio: '9:16',
      customResolution: null,
      canvasSize: [1080, 1920],
      displayLabel: '自定义',
      error: '宽高比例需在 1:8 到 8:1 之间。',
    };
  }

  if (wRaw < 64 && hRaw < 64) {
    const aspectRatio = canonicalAspectRatio(wRaw, hRaw);
    const canvasSize = defaultCanvasForAspectRatio(aspectRatio);
    return {
      valid: true,
      aspectRatio,
      customResolution: null,
      canvasSize,
      displayLabel: aspectRatio,
    };
  }

  if (wRaw >= 64 && wRaw <= 7680 && hRaw >= 64 && hRaw <= 7680) {
    const evenW = Math.min(7680, Math.max(64, Math.floor((wRaw + 1) / 2) * 2));
    const evenH = Math.min(7680, Math.max(64, Math.floor((hRaw + 1) / 2) * 2));
    const aspectRatio = canonicalAspectRatio(evenW, evenH);
    const customResolution = `${evenW}x${evenH}`;
    return {
      valid: true,
      aspectRatio,
      customResolution,
      canvasSize: [evenW, evenH],
      displayLabel: `${aspectRatio}（${evenW}×${evenH}）`,
    };
  }

  return {
    valid: false,
    aspectRatio: '9:16',
    customResolution: null,
    canvasSize: [1080, 1920],
    displayLabel: '自定义',
    error: '像素分辨率范围需在 64–7680 之间（如 1080 × 1440），或输入小于 64 的比例数字（如 21 × 9）。',
  };
}

export function formatStudioRatioBadge(
  aspectRatio?: string | null,
  customResolution?: string | null,
): string {
  const ratio = aspectRatio?.trim() || '9:16';
  if (customResolution && /^\d+x\d+$/i.test(customResolution.trim())) {
    return `${ratio}（${customResolution.trim().toLowerCase().replace('x', '×')}）`;
  }
  return ratio;
}

export function toStudioCssAspect(
  aspectRatio?: string | null,
  customResolution?: string | null,
): string {
  if (customResolution) {
    const resMatch = /^(\d+)x(\d+)$/i.exec(customResolution.trim());
    if (resMatch && Number(resMatch[1]) > 0 && Number(resMatch[2]) > 0) {
      return `${resMatch[1]} / ${resMatch[2]}`;
    }
  }
  const ratioMatch = /^(\d+):(\d+)$/.exec((aspectRatio ?? '').trim());
  if (ratioMatch && Number(ratioMatch[1]) > 0 && Number(ratioMatch[2]) > 0) {
    return `${ratioMatch[1]} / ${ratioMatch[2]}`;
  }
  return '16 / 9';
}
