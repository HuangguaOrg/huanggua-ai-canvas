import { useEffect, useRef, useState } from 'react';
import { Check, ImageOff, Upload, X } from 'lucide-react';
import {
  DEFAULT_STYLE_TEMPLATE_ID,
  STUDIO_STYLE_CATEGORIES,
  findStyleTemplate,
  getStyleTemplatesByCategory,
  type StudioStyleCategory,
  type StudioStylePickerValue,
} from './styleTemplates';

function useObjectPreview(file: File | null): string | null {
  const [preview, setPreview] = useState<{ file: File; url: string } | null>(null);
  useEffect(() => {
    if (!file) return;
    let active = true;
    const reader = new FileReader();
    reader.onload = () => {
      if (active && typeof reader.result === 'string') {
        setPreview({ file, url: reader.result });
      }
    };
    reader.readAsDataURL(file);
    return () => {
      active = false;
    };
  }, [file]);
  return preview?.file === file ? preview.url : null;
}

function TemplateCard({
  thumbnail,
  label,
  tagline,
  isSelected,
  isDefault,
  onClick,
}: {
  thumbnail: string;
  label: string;
  tagline: string;
  isSelected: boolean;
  isDefault: boolean;
  onClick: () => void;
}) {
  const [broken, setBroken] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={isSelected}
      onClick={onClick}
      className={`group relative aspect-[3/4] overflow-hidden rounded-lg bg-canvas-card text-left transition-all focus-visible:outline-none ${
        isSelected
          ? 'ring-2 ring-[var(--brand)] shadow-md'
          : 'ring-1 ring-canvas-border hover:ring-canvas-text-muted'
      }`}
    >
      {!broken && (
        <img
          src={thumbnail}
          alt=""
          width={240}
          height={320}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
          onError={() => setBroken(true)}
        />
      )}
      <div
        className="absolute inset-x-0 bottom-0 px-2.5 pb-2 pt-7"
        style={{ background: 'linear-gradient(to bottom, transparent, rgba(10, 11, 16, 0.92))' }}
      >
        <p className="truncate text-xs font-medium text-white">{label}</p>
        {tagline && <p className="mt-0.5 truncate text-[11px] text-white/75">{tagline}</p>}
      </div>
      {isSelected && (
        <span className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-[var(--brand)] text-white shadow">
          <Check size={12} strokeWidth={3} aria-hidden />
        </span>
      )}
      {isDefault && (
        <span className="absolute left-1.5 top-1.5 rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
          默认
        </span>
      )}
    </button>
  );
}

export function StudioStylePicker({
  value,
  onChange,
}: {
  value: StudioStylePickerValue;
  onChange: (next: StudioStylePickerValue) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const filePreview = useObjectPreview(value.uploadedFile);
  const preview = value.uploadedFile ? filePreview : value.uploadedPreview;
  const activeTab = value.mode === 'custom' ? 'custom' : value.activeCategory;

  const switchTab = (tab: StudioStyleCategory | 'custom') => {
    if (tab === 'custom') {
      onChange({ ...value, mode: 'custom' });
    } else {
      onChange({ ...value, mode: 'template', activeCategory: tab });
    }
  };

  const handleFile = (file?: File | null) => {
    if (!file) return;
    onChange({
      ...value,
      mode: 'custom',
      templateId: null,
      uploadedFile: file,
      uploadedPreview: null,
    });
  };

  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="画面风格分类" className="inline-flex rounded-lg border border-canvas-border bg-canvas-card p-1">
        {STUDIO_STYLE_CATEGORIES.map(tab => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => switchTab(tab.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                active
                  ? 'bg-[var(--brand)] text-white shadow-sm'
                  : 'text-canvas-text-secondary hover:text-canvas-text'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab !== 'custom' ? (
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
          {getStyleTemplatesByCategory(activeTab).map(tpl => (
            <TemplateCard
              key={tpl.id}
              thumbnail={tpl.thumbnail}
              label={tpl.name}
              tagline={tpl.tagline}
              isSelected={value.mode === 'template' && value.templateId === tpl.id}
              isDefault={tpl.id === DEFAULT_STYLE_TEMPLATE_ID}
              onClick={() => onChange({ ...value, mode: 'template', templateId: tpl.id })}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-xs leading-6 text-canvas-text-secondary">
            上传一张风格参考图，图片保存在本地项目记录；进入生成环节时 AI 会分析并参考它的画风。上传后不再使用风格模版。
          </p>
          {preview ? (
            <div className="relative overflow-hidden rounded-lg border border-canvas-border bg-canvas-card">
              <img src={preview} alt="风格参考图预览" className="h-52 w-full object-contain" />
              <div className="absolute right-2 top-2 flex gap-1.5">
                <button
                  type="button"
                  className="ui-btn ui-btn--sm bg-black/70 text-white hover:bg-black/85"
                  onClick={() => fileInputRef.current?.click()}
                >
                  更换参考图
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn--sm bg-black/70 text-white hover:bg-black/85"
                  aria-label="移除参考图"
                  onClick={() => onChange({ ...value, uploadedFile: null, uploadedPreview: null })}
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => {
                e.preventDefault();
                handleFile(e.dataTransfer.files?.[0]);
              }}
              className="flex w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-canvas-border bg-canvas-card/50 px-4 py-10 text-xs text-canvas-text-secondary transition-colors hover:border-[var(--brand)] hover:bg-canvas-hover hover:text-canvas-text"
            >
              <Upload size={18} aria-hidden />
              <span className="font-medium">上传风格参考图（支持点击或拖入）</span>
              <span className="text-[11px] text-canvas-text-muted">PNG / JPG / WEBP（保存在本地项目记录）</span>
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".png,.jpg,.jpeg,.webp"
            onChange={e => {
              handleFile(e.target.files?.[0]);
              e.target.value = '';
            }}
            className="hidden"
          />
        </div>
      )}
    </div>
  );
}

export function StudioCurrentStyleSummary({
  templateId,
  hasStyleImage,
  styleImageUrl,
  styleDescription,
  legacyStyleText,
}: {
  templateId?: string | null;
  hasStyleImage?: boolean;
  styleImageUrl?: string | null;
  styleDescription?: string | null;
  legacyStyleText?: string | null;
}) {
  const template = findStyleTemplate(templateId);
  let title = '未设置风格（必选）';
  let subtitle = '开始制作前，请先选择一个画面风格模版或上传一张风格参考图。';
  let thumb: string | null = null;
  let configured = false;

  if (hasStyleImage || styleImageUrl) {
    title = '自定义风格（本地风格参考图）';
    subtitle = styleDescription?.trim() || '已保存在本地项目记录；进入生成环节时自动分析并对齐画风。';
    thumb = styleImageUrl ?? null;
    configured = true;
  } else if (template) {
    title = `${template.name} · ${template.category === 'live' ? 'AI 真人剧' : 'AI 漫剧'}`;
    subtitle = template.tagline;
    thumb = template.thumbnail;
    configured = true;
  } else if (legacyStyleText?.trim()) {
    title = '自定义文本画风';
    subtitle = legacyStyleText.trim();
    configured = true;
  }

  return (
    <div className={`flex min-w-0 items-center gap-3 rounded-lg border p-3 ${
      configured
        ? 'border-canvas-border bg-canvas-card/60'
        : 'border-amber-500/40 bg-amber-500/10'
    }`}>
      <div className="grid h-16 w-12 shrink-0 place-items-center overflow-hidden rounded-md border border-canvas-border bg-canvas-bg">
        {thumb ? (
          <img src={thumb} alt="" className="h-full w-full object-cover" />
        ) : (
          <ImageOff size={16} className="text-canvas-text-muted" aria-hidden />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-semibold text-canvas-text">{title}</p>
        <p className="mt-1 line-clamp-2 text-xs leading-5 text-canvas-text-secondary">{subtitle}</p>
      </div>
    </div>
  );
}
