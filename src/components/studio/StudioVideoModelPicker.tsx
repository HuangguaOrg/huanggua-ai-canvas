import { useEffect, useRef, useState } from 'react';
import Select from '../shared/Select';
import { useT } from '../../i18n';
import { studioWorkspace, workspaceError, type StudioScope } from '../../services/studioWorkspaceService';
import type { StudioVideoSpec } from '../../types/studio';

interface Props {
  scope: StudioScope;
  ids: string[];
  specs: Record<string, StudioVideoSpec>;
  value: string;
  lock?: string;
  disabled: boolean;
  onChange: (id: string, lock?: string) => void;
}

export default function StudioVideoModelPicker({ scope, ids, specs, value, lock, disabled, onChange }: Props) {
  const t = useT();
  const [lookup, setLookup] = useState<{
    catalog: Props['specs'];
    detail?: StudioVideoSpec | null;
    pending?: StudioVideoSpec;
    busy?: boolean;
    error?: string;
  }>();
  const { detail, pending, busy, error } = lookup?.catalog === specs ? lookup : {};
  const [filteredCatalog, setFilteredCatalog] = useState<Props['specs']>();
  const compatibleOnly = filteredCatalog === specs;
  const sequence = useRef({ id: 0 });
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const requests = sequence.current;
    return () => { requests.id++; };
  }, [scope.projectId, scope.episodeId, specs]);
  useEffect(() => {
    if (pending) dialog.current?.showModal();
  }, [pending]);

  const spec = detail === null || detail?.id === value ? detail : specs[value];
  const tiers = spec?.seconds_by_resolution ?? {};
  const effective = lock || spec?.default_resolution;
  const missing = value && !ids.includes(value) && specs[value]?.spec_status !== 'unknown';
  const choices = [...new Set([...ids, ...Object.keys(specs).filter(id => specs[id].spec_status === 'unknown')])];
  const options = choices.filter(id => !compatibleOnly || !lock || Boolean(specs[id]?.seconds_by_resolution?.[lock]))
    .map(id => ({ value: id, label: specs[id]?.display_name || id }));
  if (value && !options.some(option => option.value === value)) options.unshift({ value, label: specs[value]?.display_name ?? value });

  const choose = async (id: string) => {
    const ticket = ++sequence.current.id;
    setLookup({ catalog: specs, busy: true });
    try {
      const result = await studioWorkspace<{ spec: StudioVideoSpec | null }>(scope, 'video_spec', { id });
      if (ticket !== sequence.current.id) return;
      const next = result.spec;
      if (lock && next?.default_resolution && next.seconds_by_resolution && !(lock in next.seconds_by_resolution)) {
        setLookup({ catalog: specs, pending: next });
      } else {
        onChange(id, lock);
        setLookup({ catalog: specs, detail: next });
        setFilteredCatalog(undefined);
      }
    } catch (err) {
      if (ticket === sequence.current.id) setLookup({ catalog: specs, error: workspaceError(err) });
    }
  };
  const unavailable = missing || detail === null || spec?.spec_status === 'unknown';
  return <div className="space-y-1.5 text-[11px] text-canvas-text-muted">
    <label className="block">{t('视频模型')}
      <Select aria-label={t('视频模型')} className="mt-1 w-full" options={options} value={value} disabled={disabled || busy}
        onChange={id => void choose(id)} />
    </label>
    <p role="status" aria-live="polite">{busy ? t('正在核对模型规格…') : error || (unavailable
      ? t('此模型暂无可用规格，请刷新模型或更换模型。分镜已保留。')
      : effective ? t('本集使用 {size}', { size: effective }) : '')}</p>
    {compatibleOnly && <button className="ui-btn ui-btn--sm" onClick={() => setFilteredCatalog(undefined)}>{t('显示全部模型')}</button>}
    {!unavailable && effective && Object.keys(tiers).length > 0 && <details>
      <summary className="cursor-pointer">{lock ? t('素材分辨率 · 已锁定') : t('素材分辨率 · 跟随模型')}</summary>
      <Select aria-label={t('本集素材分辨率')} className="mt-1 w-full" value={lock ?? ''} disabled={disabled || busy}
        options={[{ value: '', label: t('跟随模型（推荐）') }, ...Object.keys(tiers).map(size => ({ value: size, label: t('锁定 {size}', { size }) }))]}
        onChange={size => { setFilteredCatalog(undefined); onChange(value, size || undefined); }} />
    </details>}
    {pending && <dialog ref={dialog} onCancel={() => setLookup(undefined)} aria-label={t('本集素材分辨率冲突')}
      className="m-auto max-w-sm space-y-3 rounded-xl border border-canvas-border bg-canvas-card p-4 text-sm text-canvas-text backdrop:bg-black/50">
      <p>{t('{model} 支持 {sizes}。本集已锁定原生 {lock}。', { model: pending.display_name, sizes: Object.keys(pending.seconds_by_resolution ?? {}).join(' / '), lock: lock ?? '' })}</p>
      <div className="flex flex-wrap gap-2">
        <button className="ui-btn ui-btn--primary" onClick={() => {
          onChange(pending.id, pending.default_resolution!);
          setLookup({ catalog: specs, detail: pending }); setFilteredCatalog(undefined);
        }}>{t('本集改用 {size}', { size: pending.default_resolution! })}</button>
        <button className="ui-btn" onClick={() => { setLookup(undefined); setFilteredCatalog(specs); }}>{t('保留 {size}，换模型', { size: lock ?? '' })}</button>
        <button className="ui-btn" onClick={() => setLookup(undefined)}>{t('取消')}</button>
      </div>
    </dialog>}
  </div>;
}
