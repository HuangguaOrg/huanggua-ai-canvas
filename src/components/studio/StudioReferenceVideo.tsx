import { useState } from 'react';
import type { StudioEpisode, StudioProject, StudioStagingPrecheck } from '../../types/studio';
import { useAppStore } from '../../store/useAppStore';
import { useWorkspaceQuery } from './useWorkspaceQuery';
import { studioWorkspace, workspaceError } from '../../services/studioWorkspaceService';
import { pollStudioExecutions } from '../../services/studioExecutionService';
import StudioUpload from './StudioUpload';
import StudioVersions from './StudioVersions';
import StudioStagingNotice from './StudioStagingNotice';
import ModalOverlay from '../shared/ModalOverlay';
import { Feedback, type ProductionReply } from './StudioProductionSetup';

interface Unit { unit_id: string; text: string; duration_seconds: number; note?: string; source_text?: string; needs_replan?: boolean; pending_authoring?: boolean; generated_assets?: { video_clip?: string; video_thumbnail?: string } }
interface Capability { unregistered_references?: string[]; allowed_durations?: number[]; problems?: unknown[]; problem?: unknown; unavailable_references?: { name: string }[] }
interface Admission extends ProductionReply {
  estimated_cost?: Record<string, number>;
  unpriced_count?: number;
  needs_confirmation?: boolean;
  request_duration?: number;
  stagingSpec?: StudioStagingPrecheck;
  units?: { unit_id: string; request_duration_seconds?: number; problems: unknown[] }[];
  confirmation?: { tiers: { request_duration_seconds: number; unit_ids: string[] }[] };
}

export default function StudioReferenceVideo({ project, episode }: { project: StudioProject; episode: StudioEpisode }) {
  const scope = { projectId: project.id, episodeId: episode.id };
  const query = useWorkspaceQuery<{ units?: Unit[]; unit_capabilities?: Record<string, Capability>; unit_references?: Record<string, { images?: string[]; videos?: string[] }>; rejected?: boolean; diagnostic?: unknown }>(scope, 'reference_units');
  const assets = useWorkspaceQuery<{ project?: Record<string, Record<string, unknown>> }>(scope, 'project');
  const execution = useAppStore(s => s.studioExecutions[`${project.id}/${episode.id}`]);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [editing, setEditing] = useState<Unit | 'new'>(); const [text, setText] = useState(''); const [duration, setDuration] = useState(5); const [note, setNote] = useState('');
  const [preview, setPreview] = useState<unknown>();
  const [confirm, setConfirm] = useState<{ action: string; id?: string; data: Record<string, unknown>; reply?: Admission }>();
  const units = query.data?.units ?? []; const unit = units.find(u => u.unit_id === selected) ?? units[0];
  const index = unit ? units.indexOf(unit) : -1;
  const capability = query.data?.unit_capabilities?.[unit?.unit_id ?? ''];
  const unitRefs = query.data?.unit_references?.[unit?.unit_id ?? ''];
  const artifacts = execution?.artifacts ?? [];
  const media = artifacts.find(a => a.name === unit?.generated_assets?.video_clip);
  const mentions = ['products', 'characters', 'scenes', 'props'].flatMap(category => Object.keys(assets.data?.project?.[category] ?? {}).map(name => ({ name, category })));
  const refresh = async () => { query.refresh(); await pollStudioExecutions(); };
  const perform = async (action: string, id?: string, data: Record<string, unknown> = {}) => {
    const result = await studioWorkspace<ProductionReply>(scope, action, { id, data });
    if (result.rejected || result.decision === 'blocked' || result.decision === 'confirmation_required' || (Array.isArray(result.enqueue_failures) && result.enqueue_failures.length > 0)) { setPreview(result.diagnostic ?? result); return false; }
    await refresh(); return true;
  };
  const removeUnitRef = async (relPath: string) => {
    if (!unit) return;
    setBusy(true); setError('');
    try {
      await studioWorkspace(scope, 'local_ref_remove', { id: unit.unit_id, data: { scopeKind: 'unit', path: relPath } });
      await refresh();
    } catch (e) { setError(workspaceError(e)); } finally { setBusy(false); }
  };
  const edit = (value: Unit | 'new') => { setEditing(value); setText(value === 'new' ? '' : value.text); setDuration(value === 'new' ? 5 : value.duration_seconds); setNote(value === 'new' ? '' : value.note ?? ''); setPreview(undefined); setError(''); };
  const save = async () => { setBusy(true); setError(''); try { if (await perform(editing === 'new' ? 'reference_add' : 'reference_update', editing === 'new' ? undefined : editing?.unit_id, { prompt: text, duration_seconds: duration, note })) setEditing(undefined); } catch (e) { setError(workspaceError(e)); } finally { setBusy(false); } };
  const preflight = async (batch: boolean) => {
    if (!batch && !unit) return;
    setBusy(true); setError(''); setPreview(undefined);
    try {
      const result = await studioWorkspace<Admission>(scope, batch ? 'reference_batch_preview' : 'reference_precheck', { id: batch ? undefined : unit.unit_id, data: {} });
      if (result.rejected || result.decision === 'blocked') { setPreview(result.diagnostic ?? result); return; }
      const confirmations = Object.fromEntries((result.confirmation?.tiers ?? []).flatMap(tier => tier.unit_ids.map(id => [id, tier.request_duration_seconds])));
      setConfirm({ action: batch ? 'reference_batch' : 'reference_generate', id: batch ? undefined : unit.unit_id, data: batch ? { confirmed_request_durations: confirmations } : result.needs_confirmation ? { confirmed_request_duration_seconds: result.request_duration } : {}, reply: result });
    } catch (e) { setError(workspaceError(e)); } finally { setBusy(false); }
  };
  const submit = async () => { if (!confirm) return; setBusy(true); setError(''); try { if (await perform(confirm.action, confirm.id, confirm.data)) setConfirm(undefined); } catch (e) { setError(workspaceError(e)); } finally { setBusy(false); } };
  const showPreview = async () => { setBusy(true); setError(''); try { setPreview(await studioWorkspace(scope, 'reference_preview', { id: editing && editing !== 'new' ? editing.unit_id : unit?.unit_id, data: { prompt: editing ? text : unit?.text } })); } catch (e) { setError(workspaceError(e)); } finally { setBusy(false); } };
  const localImages = unitRefs?.images ?? [];
  const localVideos = unitRefs?.videos ?? [];
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-canvas-border p-3"><span className="text-sm">参考生视频 · {units.length} 个单元</span><div className="flex gap-2"><button className="ui-btn ui-btn--sm" disabled={busy || !query.ready || !!query.data?.rejected} onClick={() => edit('new')}>添加单元</button><button className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy || !units.length} onClick={() => void preflight(true)}>批量补齐视频</button><button className="ui-btn ui-btn--sm" onClick={() => void refresh()}>刷新</button></div></div>
    {(error || query.error) && <p role="alert" className="ui-alert m-3 text-xs">{error || query.error}</p>}
    {query.data?.rejected && <p className="p-5 text-sm">请先在脚本规划中创建空白脚本或生成正式脚本，再添加视频单元。</p>}
    <div className="studio-shot-split min-h-0 flex-1"><aside className="ui-scroll min-h-0 space-y-2 overflow-auto border-r border-canvas-border p-2" aria-label="视频单元列表">{units.map((u, i) => <button key={u.unit_id} className={`studio-shot-item w-full text-left ${u.unit_id === unit?.unit_id ? 'is-active' : ''}`} onClick={() => { setSelected(u.unit_id); setPreview(undefined); }}><span className="flex justify-between text-xs"><strong>{i + 1} · {u.unit_id}</strong><span>{u.duration_seconds}s</span></span><p className="my-2 line-clamp-3 text-xs leading-6">{u.text || u.source_text || '待编写'}</p><span className="text-[11px] text-canvas-text-muted">{execution?.tasks.some(t => t.resource_id === u.unit_id && ['queued', 'running'].includes(t.status)) ? '生成中' : u.needs_replan ? '需要重新规划' : u.pending_authoring ? '待编写正文' : u.generated_assets?.video_clip ? '已有视频' : '待生成'}</span></button>)}</aside>
      <div className="ui-scroll min-h-0 min-w-0 space-y-4 overflow-auto p-4">{unit ? <>
        <div className="flex flex-wrap items-center justify-between gap-2"><h3>{unit.unit_id} · {unit.duration_seconds} 秒</h3><div className="flex gap-2"><button className="ui-btn ui-btn--sm" disabled={busy || index <= 0} onClick={() => setConfirm({ action: 'reference_move', id: unit.unit_id, data: { after_unit_id: units[index - 2]?.unit_id ?? null } })}>上移</button><button className="ui-btn ui-btn--sm" disabled={busy || index >= units.length - 1} onClick={() => setConfirm({ action: 'reference_move', id: unit.unit_id, data: { after_unit_id: units[index + 1]?.unit_id } })}>下移</button><button className="ui-btn ui-btn--sm" disabled={busy} onClick={() => setConfirm({ action: 'reference_delete', id: unit.unit_id, data: {} })}>删除</button></div></div>
        <div className="grid gap-4 xl:grid-cols-2"><section className="space-y-3 rounded-lg border border-canvas-border p-4"><h4 className="text-sm">单元正文与本地参考素材</h4><p className="whitespace-pre-wrap text-sm leading-7">{unit.text || '等待编写正文'}</p>{unit.source_text && <details className="text-xs"><summary>来源原文</summary><p className="whitespace-pre-wrap leading-6">{unit.source_text}</p></details>}{unit.note && <p className="text-xs text-canvas-text-muted">{unit.note}</p>}
          <div className="flex flex-wrap gap-2"><button className="ui-btn ui-btn--sm" onClick={() => edit(unit)}>编辑正文与时长</button><button className="ui-btn ui-btn--sm" disabled={busy} onClick={() => void showPreview()}>提示词预览</button><StudioUpload scope={scope} kind="unit_ref_image" name={unit.unit_id} label="上传本地参考图" accept=".png,.jpg,.jpeg,.webp" onComplete={query.refresh} /><StudioUpload scope={scope} kind="unit_ref_video" name={unit.unit_id} label="上传本地参考视频" accept=".mp4,.mov,.m4v,.webm" onComplete={query.refresh} /></div>
          {(localImages.length > 0 || localVideos.length > 0) && <div className="space-y-2 rounded border border-canvas-border bg-canvas-card p-2 text-xs">
            <p className="text-[11px] text-canvas-text-secondary">本单元绑定的本地参考图片/视频（保存在本地记录，生成时经规格确认后暂存转 URL）</p>
            <div className="flex flex-wrap gap-2">
              {localImages.map(path => { const art = artifacts.find(a => a.name === path); return <div key={path} className="w-24 space-y-1">{art?.url ? <img className="h-16 w-24 rounded object-cover" src={art.url} alt={path} /> : <span className="block truncate text-[10px]">{path.split('/').at(-1)}</span>}<button type="button" className="ui-btn ui-btn--ghost ui-btn--sm w-full" disabled={busy} onClick={() => void removeUnitRef(path)}>移除</button></div>; })}
              {localVideos.map(path => { const art = artifacts.find(a => a.name === path); return <div key={path} className="w-40 space-y-1">{art?.url ? <video className="h-20 w-40 rounded bg-canvas-bg object-contain" src={art.url} controls preload="metadata" /> : <span className="block truncate text-[10px]">{path.split('/').at(-1)}</span>}<button type="button" className="ui-btn ui-btn--ghost ui-btn--sm w-full" disabled={busy} onClick={() => void removeUnitRef(path)}>移除</button></div>; })}
            </div>
          </div>}
        </section>
        <section className="space-y-3 rounded-lg border border-canvas-border p-4"><h4 className="text-sm">单元成片预览</h4>{media?.url ? <video className="max-h-96 w-full rounded" src={media.url} controls preload="metadata" /> : <p className="py-12 text-center text-xs text-canvas-text-muted">暂无视频</p>}<div className="flex flex-wrap gap-2"><button className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy || unit.needs_replan || unit.pending_authoring || !unit.text.trim()} onClick={() => void preflight(false)}>{media ? '重新生成视频' : '生成视频'}</button><StudioUpload scope={scope} kind="reference_video" name={unit.unit_id} label="上传本地视频作为本单元成片" accept=".mp4,.mov,.m4v,.webm" onComplete={query.refresh} /><StudioVersions scope={scope} category="reference_videos" name={unit.unit_id} artifacts={artifacts} onChange={query.refresh} /></div></section></div>
        {!!capability?.allowed_durations?.length && <p className="text-xs text-canvas-text-muted">模型时长档位：{capability.allowed_durations.join(' / ')} 秒</p>}
        {!!capability?.unavailable_references?.length && <p className="text-xs">待补参考图：{capability.unavailable_references.map(r => r.name).join('、')}</p>}{!!capability?.unregistered_references?.length && <p className="text-xs">待登记素材：{capability.unregistered_references.join('、')}</p>}{capability?.problem != null && <Feedback value={capability.problem} />}{!!capability?.problems?.length && <Feedback value={capability.problems} />}
      </> : !query.data?.rejected && <p className="py-12 text-center text-sm">暂无视频单元，点击“添加单元”开始。</p>}
      {preview != null && !editing && <div className="space-y-2 rounded border border-canvas-border p-3"><h4 className="text-sm">生成预览与检查</h4><Feedback value={preview} /><button className="ui-btn ui-btn--sm" onClick={() => setPreview(undefined)}>关闭预览</button></div>}</div>
    </div>
    <ModalOverlay isOpen={!!editing} onClose={() => !busy && setEditing(undefined)} ariaLabel="编辑视频单元" zIndex={450} className="studio-editor ui-scroll max-h-[90vh] w-[min(760px,92vw)] space-y-4 overflow-auto p-5"><form className="space-y-4" onSubmit={e => { e.preventDefault(); void save(); }}><h2>{editing === 'new' ? '添加视频单元' : '编辑视频单元'}</h2><label className="block text-sm">正文<textarea autoFocus className="ui-input mt-2" rows={9} required maxLength={30000} value={text} onChange={e => setText(e.target.value)} /></label><p className="text-xs text-canvas-text-muted">用 @[素材名称] 引用角色、场景、道具或商品，参考图由正式素材自动解析；也可在单元卡片上直接上传本地参考图或参考视频。</p><div className="flex max-h-28 flex-wrap gap-2 overflow-auto">{mentions.map(m => <button type="button" key={`${m.category}/${m.name}`} className="ui-btn ui-btn--sm" onClick={() => setText(v => `${v}@[${m.name}]`)}>{m.name}</button>)}</div><label className="block text-sm">计划时长（秒）<input className="ui-input mt-2" type="number" required min={1} max={600} value={duration} onChange={e => setDuration(Number(e.target.value))} /></label><label className="block text-sm">备注<input className="ui-input mt-2" value={note} onChange={e => setNote(e.target.value)} /></label>{preview != null && <Feedback value={preview} />}{error && <p role="alert" className="ui-alert text-xs">{error}</p>}<div className="flex gap-2"><button className="ui-btn ui-btn--primary" disabled={busy || !text.trim()}>保存单元</button>{editing !== 'new' && <button type="button" className="ui-btn" disabled={busy} onClick={() => void showPreview()}>预览草稿提示词</button>}<button type="button" className="ui-btn" disabled={busy} onClick={() => setEditing(undefined)}>取消</button></div></form></ModalOverlay>
    <ModalOverlay isOpen={!!confirm} onClose={() => !busy && setConfirm(undefined)} ariaLabel="确认单元操作" zIndex={460} className="studio-editor ui-scroll max-h-[85vh] w-[min(640px,90vw)] space-y-4 overflow-auto p-5"><h2>{confirm?.action === 'reference_delete' ? '确认删除这个单元？' : confirm?.action === 'reference_move' ? '确认调整单元顺序？' : '确认视频生成规格与参考素材暂存'}</h2>{confirm?.reply && <><p className="text-xs">生成会使用账号余额。请核对模型请求时长与参考素材规格；确认后将把所需本地素材暂存至黄瓜 AI 服务器转为 HTTPS URL 交由上游处理。</p>{confirm.reply.stagingSpec && <StudioStagingNotice precheck={confirm.reply.stagingSpec} />}{confirm.reply.request_duration && <p className="text-sm">请求时长：{confirm.reply.request_duration} 秒</p>}{confirm.reply.units?.map(u => <div key={u.unit_id} className="border-b border-canvas-border py-2 text-xs">{u.unit_id} · {u.request_duration_seconds ?? '—'} 秒<Feedback value={u.problems} /></div>)}{confirm.reply.estimated_cost && <p className="text-xs">参考费用：{Object.entries(confirm.reply.estimated_cost).map(([currency, amount]) => `${amount} ${currency}`).join(' / ')}</p>}{!!confirm.reply.unpriced_count && <p className="text-xs">另有 {confirm.reply.unpriced_count} 个单元无法报价，未计入以上估算。</p>}<Feedback value={confirm.reply} /></>}{preview != null && <Feedback value={preview} />}{error && <p role="alert" className="text-xs">{error}</p>}<div className="flex gap-2"><button className="ui-btn ui-btn--primary" disabled={busy} onClick={() => void submit()}>{confirm?.reply ? '确认规格并生成' : '确认'}</button><button className="ui-btn" disabled={busy} onClick={() => setConfirm(undefined)}>取消</button></div></ModalOverlay>
  </div>;
}
