import Select from '../shared/Select';
import {
  STUDIO_CUSTOM_QUICK_PRESETS,
  STUDIO_CUSTOM_RATIO_OPTION,
  STUDIO_RATIO_SELECT_OPTIONS,
  parseCombinedPairInput,
  resolveStudioRatioDraft,
  type StudioRatioDraft,
} from './studioRatios';

interface StudioRatioPickerProps {
  label: string;
  ariaLabel: string;
  value: StudioRatioDraft;
  onChange: (next: StudioRatioDraft) => void;
  disabled?: boolean;
  helperText?: string;
}

export default function StudioRatioPicker({
  label,
  ariaLabel,
  value,
  onChange,
  disabled = false,
  helperText,
}: StudioRatioPickerProps) {
  const selectValue = value.mode === 'custom' ? STUDIO_CUSTOM_RATIO_OPTION : value.presetRatio;
  const resolved = resolveStudioRatioDraft(value);

  const handleSelectChange = (selected: string) => {
    if (selected === STUDIO_CUSTOM_RATIO_OPTION) {
      onChange({ ...value, mode: 'custom' });
    } else {
      onChange({ ...value, mode: 'preset', presetRatio: selected });
    }
  };

  const handleWidthChange = (raw: string) => {
    const combined = parseCombinedPairInput(raw);
    if (combined) {
      onChange({
        ...value,
        mode: 'custom',
        customWidth: combined.width,
        customHeight: combined.height,
      });
      return;
    }
    onChange({
      ...value,
      mode: 'custom',
      customWidth: raw.replace(/[^\d]/g, '').slice(0, 4),
    });
  };

  const handleHeightChange = (raw: string) => {
    const combined = parseCombinedPairInput(raw);
    if (combined) {
      onChange({
        ...value,
        mode: 'custom',
        customWidth: combined.width,
        customHeight: combined.height,
      });
      return;
    }
    onChange({
      ...value,
      mode: 'custom',
      customHeight: raw.replace(/[^\d]/g, '').slice(0, 4),
    });
  };

  return (
    <div className="space-y-2">
      <label className="block text-sm">
        {label}
        <Select
          aria-label={ariaLabel}
          className="mt-2 w-full"
          disabled={disabled}
          value={selectValue}
          onChange={handleSelectChange}
          options={STUDIO_RATIO_SELECT_OPTIONS.map((item) => ({ value: item.value, label: item.label }))}
        />
      </label>

      {value.mode === 'custom' && (
        <div className="space-y-2.5 rounded-lg border border-canvas-border bg-canvas-card p-3">
          <div className="flex items-center gap-2">
            <label className="flex-1 text-xs text-canvas-text-secondary">
              宽度（像素或比例）
              <input
                type="text"
                inputMode="numeric"
                aria-label="自定义宽度"
                disabled={disabled}
                value={value.customWidth}
                placeholder="例如 1080 或 21"
                onChange={(event) => handleWidthChange(event.target.value)}
                className="ui-input mt-1 w-full tabular-nums"
              />
            </label>
            <span className="pt-5 text-sm text-canvas-text-muted">×</span>
            <label className="flex-1 text-xs text-canvas-text-secondary">
              高度（像素或比例）
              <input
                type="text"
                inputMode="numeric"
                aria-label="自定义高度"
                disabled={disabled}
                value={value.customHeight}
                placeholder="例如 1440 或 9"
                onChange={(event) => handleHeightChange(event.target.value)}
                className="ui-input mt-1 w-full tabular-nums"
              />
            </label>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {STUDIO_CUSTOM_QUICK_PRESETS.map((preset) => {
              const isSelected = value.customWidth === preset.width && value.customHeight === preset.height;
              return (
                <button
                  key={preset.label}
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange({
                    ...value,
                    mode: 'custom',
                    customWidth: preset.width,
                    customHeight: preset.height,
                  })}
                  className={`rounded border px-2 py-1 text-[11px] transition-colors ${
                    isSelected
                      ? 'border-[var(--brand)] bg-[var(--brand-alpha-15)] text-canvas-text'
                      : 'border-canvas-border bg-canvas-surface text-canvas-text-secondary hover:bg-canvas-hover'
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>

          {resolved.valid ? (
            <p className="text-xs text-canvas-text-muted">
              生效比例 <span className="font-medium text-canvas-text">{resolved.aspectRatio}</span>
              {' · '}
              目标画布 <span className="font-medium tabular-nums text-canvas-text">{resolved.canvasSize[0]}×{resolved.canvasSize[1]}</span>
              {resolved.customResolution ? '（自定义像素分辨率，奇数自动对齐偶数像素）' : '（自定义画面比例，短边默认 1080p）'}
            </p>
          ) : (
            <p role="alert" className="text-xs text-amber-400">
              {resolved.error}
            </p>
          )}
        </div>
      )}

      {helperText && (
        <span className="block text-xs leading-5 text-canvas-text-muted">
          {helperText}
        </span>
      )}
    </div>
  );
}
