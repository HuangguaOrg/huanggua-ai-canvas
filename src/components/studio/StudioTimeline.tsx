import { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../../i18n';
import { studioWorkspace, workspaceError, type StudioScope } from '../../services/studioWorkspaceService';
import { pollStudioExecutions } from '../../services/studioExecutionService';
import type { StudioArtifact } from '../../types/studio';
import { useWorkspaceQuery } from './useWorkspaceQuery';
import { useStudioScript } from './useStudioScript';
import type { EditTimelinePreviewMedia, EditTimelineReadout, EditTimelineSummary } from './timeline/types';
import { buildPlaybackPlan, locate, transitionOpacity, type PlaybackSegment } from './timeline/playback-schedule';
import { bgmPlacements, narrationPlacements, placeSubtitles, subtitleAt, type AudioPlacement } from './timeline/preview-tracks';
import { useTimelinePlayback } from './timeline/useTimelinePlayback';
import { toStudioCssAspect } from './studioRatios';
import Select from '../shared/Select';
import ModalOverlay from '../shared/ModalOverlay';
import StudioUpload from './StudioUpload';
import { open } from '@tauri-apps/plugin-dialog';

const issueLabels: Record<string, string> = { trim_ignored: '素材版本已变化，请重新设置截取范围', unit_deleted: '镜头已从脚本删除', unit_unused: '镜头未加入时间线', video_missing: '缺少镜头视频', hold_too_long: '定格时间过长', narration_missing: '缺少旁白音频', narration_overrun: '旁白超过片段时长', narration_source_collision: '旁白与视频原声重叠', subtitle_missing_glyphs: '字幕字体缺少部分字符', bgm_missing: '缺少背景音乐' };

export default function StudioTimeline({ scope, artifacts, onAsk }: { scope: StudioScope; artifacts: StudioArtifact[]; onAsk: () => void }) {
  const t = useT();
  const list = useWorkspaceQuery<{ timelines: EditTimelineSummary[] }>(scope, 'timelines');
  const project = useWorkspaceQuery<{ project: { aspect_ratio?: string; desktop_custom_resolution?: string | null } | null }>(scope, 'project');
  const [selected, setSelected] = useState('');
  const id = list.data?.timelines.some(item => item.id === selected) ? selected : list.data?.timelines[0]?.id;
  const read = useWorkspaceQuery<EditTimelineReadout>(scope, 'timeline_read', id, !!id);
  const media = useWorkspaceQuery<EditTimelinePreviewMedia>(scope, 'timeline_media', id, !!id);
  const revisions = useWorkspaceQuery<{ revisions: Array<{ number: number; summary?: string }> }>(scope, 'timeline_revisions', id, !!id);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [dialog, setDialog] = useState<'create' | 'rename' | 'copy' | 'delete' | 'export_draft' | null>(null);
  const [directory, setDirectory] = useState('');
  const [version, setVersion] = useState('6');
  const [name, setName] = useState('');
  const [narration, setNarration] = useState('without_narration');
  const [subtitles, setSubtitles] = useState('burned_subtitles');
  const [revision, setRevision] = useState('');
  const refresh = () => { list.refresh(); read.refresh(); media.refresh(); revisions.refresh(); void pollStudioExecutions(); };
  const act = async (action: string, data: Record<string, unknown> = {}) => {
    setBusy(true); setMessage('');
    try {
      const result = await studioWorkspace<{ id?: string; timeline?: { id: string }; task_id?: string; status?: string }>(scope, action, { id, data });
      if (action === 'timeline_create' || action === 'timeline_copy') setSelected(result.id ?? result.timeline?.id ?? '');
      if (action === 'timeline_delete') setSelected('');
      setDialog(null); refresh();
      setMessage(result.task_id ? '已加入制作队列，完成后自动进入个人资源库。' : result.status ? ({ current: '当前版本已生成', stale: '已有成片需要更新', missing: '尚未生成', exported: '导出包已准备，将自动进入文件页与个人资源库。', blocked: '素材尚未齐全' }[result.status] ?? result.status) : '已完成');
    } catch (error) { setMessage(workspaceError(error)); } finally { setBusy(false); }
  };
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex flex-wrap items-center gap-2 border-b border-canvas-border p-3 text-xs">
      <Select aria-label={t('剪辑时间线')} className="min-w-36" value={id ?? ''} options={(list.data?.timelines ?? []).map(item => ({ value: item.id, label: item.name }))} onChange={setSelected} />
      <button className="ui-btn ui-btn--sm" disabled={busy || !list.ready} onClick={() => { setName(`完整版 ${(list.data?.timelines.length ?? 0) + 1}`); setDialog('create'); }}>{t('新建时间线')}</button>
      {id && <><button className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => { setName(list.data?.timelines.find(x => x.id === id)?.name ?? ''); setDialog('rename'); }}>{t('重命名')}</button><button className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => { setName(`${list.data?.timelines.find(x => x.id === id)?.name} 副本`); setDialog('copy'); }}>{t('复制')}</button><button className="ui-btn ui-btn--ghost ui-btn--sm" onClick={() => setDialog('delete')}>{t('删除')}</button></>}
      <button className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy} onClick={refresh}>{t('刷新')}</button><button className="ui-btn ui-btn--ghost ui-btn--sm" onClick={onAsk}>{t('让 Agent 剪辑')}</button>
      <StudioUpload scope={scope} kind="bgm" label="上传背景音乐" accept=".mp3,.wav,.m4a,.ogg" onComplete={refresh} />
    </div>
    {(message || list.error || read.error || media.error) && <p className="ui-alert m-3 text-xs" role="status">{t(message || list.error || read.error || media.error || '')}</p>}
    {read.data && id ? <>
      <TimelinePlayer key={id} readout={read.data} media={media.data ?? null} artifacts={artifacts} withNarration={narration === 'with_narration'} aspect={toStudioCssAspect(project.data?.project?.aspect_ratio, project.data?.project?.desktop_custom_resolution)} />
      <div className="flex flex-wrap items-center gap-2 border-t border-canvas-border p-3 text-xs">
        <Select aria-label={t('旁白版本')} value={narration} options={[{ value: 'without_narration', label: t('不带旁白') }, { value: 'with_narration', label: t('带旁白') }]} onChange={setNarration} />
        <Select aria-label={t('字幕版本')} value={subtitles} options={[{ value: 'burned_subtitles', label: t('烧录字幕') }, { value: 'no_subtitles', label: t('不带字幕') }]} onChange={setSubtitles} />
        <button className="ui-btn ui-btn--primary ui-btn--sm" disabled={busy} onClick={() => void act('timeline_render', { revision: read.data?.revision, narration, subtitles })}>{t('生成成片')}</button>
        <button className="ui-btn ui-btn--sm" disabled={busy} onClick={() => void act('timeline_draft', { narration })}>{t('生成剪映草稿')}</button>
        <button className="ui-btn ui-btn--sm" disabled={busy} onClick={() => { setMessage(''); setDialog('export_draft'); }}>{t('导出剪映草稿')}</button>
        <button className="ui-btn ui-btn--ghost ui-btn--sm" disabled={busy} onClick={() => void act('timeline_render_status', { narration, subtitles })}>{t('成片状态')}</button>
        {!!revisions.data?.revisions.length && <><Select aria-label={t('时间线历史版本')} value={revision} options={[{ value: '', label: t('历史版本') }, ...revisions.data.revisions.map(r => ({ value: String(r.number), label: `v${r.number}` }))]} onChange={setRevision} /><button className="ui-btn ui-btn--sm" disabled={!revision || busy} onClick={() => void act('timeline_restore', { revision: Number(revision) })}>{t('恢复此版本')}</button></>}
      </div>
    </> : <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center text-sm"><p>{t('暂无剪辑时间线')}</p><p className="text-xs text-canvas-text-muted">{t('生成镜头视频后，新建时间线或让 Agent 按要求剪辑。')}</p></div>}
    <ModalOverlay isOpen={!!dialog} onClose={() => !busy && setDialog(null)} ariaLabel={t('管理时间线')} zIndex={400} className="studio-editor w-[min(420px,90vw)] p-5">
      <form onSubmit={e => { e.preventDefault(); void act(`timeline_${dialog}`, dialog === 'export_draft' ? { directory, version, narration } : { name }); }} className="space-y-4"><h2>{t(dialog === 'delete' ? '删除这条时间线？生成资源仍保留在个人资源库。' : dialog === 'export_draft' ? '选择剪映的草稿目录，导出后将压缩包解压到该目录。' : '时间线名称')}</h2>{dialog !== 'delete' && dialog !== 'export_draft' && <input autoFocus required maxLength={100} className="ui-input" value={name} onChange={e => setName(e.target.value)} />}{dialog === 'export_draft' && <div className="space-y-3"><button type="button" className="ui-btn" onClick={() => void open({ directory: true, multiple: false }).then(path => { if (typeof path === 'string') setDirectory(path); }, () => setMessage('无法打开目录选择器。'))}>{t('选择草稿目录')}</button><p className="break-all text-xs">{directory}</p><Select aria-label={t('剪映版本')} value={version} options={[{ value: '6', label: '剪映 6 及以上' }, { value: '5', label: '剪映 5' }]} onChange={setVersion} /></div>}<div className="flex justify-end gap-2"><button type="button" disabled={busy} className="ui-btn" onClick={() => setDialog(null)}>{t('取消')}</button><button disabled={busy || (dialog === 'export_draft' ? !directory.trim() : dialog !== 'delete' && !name.trim())} className="ui-btn ui-btn--primary">{t('确认')}</button></div>{message && <p role="alert" className="text-xs">{t(message)}</p>}</form>
    </ModalOverlay>
  </div>;
}

function TimelinePlayer({ readout, media, artifacts, withNarration, aspect }: { readout: EditTimelineReadout; media: EditTimelinePreviewMedia | null; artifacts: StudioArtifact[]; withNarration: boolean; aspect: string }) {
  const t = useT();
  const script = useStudioScript(artifacts);
  const plan = useMemo(() => buildPlaybackPlan(readout, media), [readout, media]);
  const audio = useMemo(() => [...(withNarration ? narrationPlacements(readout, media) : []), ...bgmPlacements(readout, media)], [readout, media, withNarration]);
  const cues = useMemo(() => placeSubtitles(readout, plan, media), [readout, plan, media]);
  const sourcesKey = JSON.stringify(script.shots?.map(s => [s.id, s.video?.url ?? null]) ?? []);
  const sources = useMemo(() => new Map<string, string | null>(JSON.parse(sourcesKey)), [sourcesKey]);
  const sourceUrl = useCallback((segment: PlaybackSegment) => sources.get(segment.unitId) ?? null, [sources]);
  const audioUrl = useCallback((placement: AudioPlacement) => {
    const path = placement.kind === 'bgm' ? media?.bgm.find(x => x.bgm_id === placement.sourceId)?.path : media?.units.find(x => x.unit_id === placement.sourceId)?.narration_audio?.path;
    return artifacts.find(a => a.name === path)?.url ?? null;
  }, [media, artifacts]);
  const playback = useTimelinePlayback(plan, sourceUrl, audio, audioUrl);
  const cue = subtitleAt(cues, playback.t);
  const current = plan.segments[locate(plan, playback.t)?.index ?? -1];
  const width = Math.max(640, Math.min(20000, readout.duration * 30));
  const duration = Math.max(readout.duration, 0.01);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      if ((event.target as HTMLElement)?.closest('input,textarea,select,button,[contenteditable="true"],[role="dialog"]')) return;
      if (event.key === ' ') { event.preventDefault(); playback.toggle(); }
      if (event.key === 'ArrowLeft') playback.seek(playback.t - 1);
      if (event.key === 'ArrowRight') playback.seek(playback.t + 1);
    };
    window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener);
  }, [playback]);
  return <div className="ui-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
    <div className="relative mx-auto my-3 h-[min(36vh,360px)] max-w-full shrink-0 overflow-hidden rounded bg-canvas-bg" style={{ aspectRatio: aspect }}>
      {playback.videoRefs.map((ref, i) => <video key={i} ref={ref} playsInline preload="metadata" className="absolute inset-0 h-full w-full object-contain" style={{ visibility: playback.visibleSlot === i ? 'visible' : 'hidden', opacity: current ? transitionOpacity(current, playback.t) : 1 }} />)}
      {(!current || !sourceUrl(current)) && <p className="absolute inset-0 flex items-center justify-center text-xs text-canvas-text-muted">{t('当前片段暂无可播放视频')}</p>}
      {cue && <p className="absolute inset-x-6 bottom-6 rounded bg-canvas-bg/80 p-2 text-center text-sm">{cue.text}</p>}
    </div>
    <div className="flex shrink-0 items-center gap-3 px-4 pb-3 text-xs"><button className="ui-btn ui-btn--sm" disabled={!plan.segments.length} onClick={playback.toggle}>{t(playback.playing ? '暂停' : '播放')}</button><input className="min-w-0 flex-1" type="range" aria-label={t('播放位置')} min={0} max={duration} step={0.01} value={playback.t} onChange={e => playback.seek(Number(e.target.value))} /><span>{playback.t.toFixed(1)} / {readout.duration.toFixed(1)}s</span>{(playback.buffering || playback.blocked) && <span>{t(playback.blocked ? '请点击播放' : '缓冲中')}</span>}</div>
    <div className="ui-scroll shrink-0 overflow-x-auto border-y border-canvas-border">
      <div style={{ minWidth: width }} className="relative w-full space-y-2 p-3 text-[10px]">
        <div className="flex justify-between text-canvas-text-muted">{Array.from({ length: 11 }, (_, i) => <span key={i}>{(duration * i / 10).toFixed(1)}s</span>)}</div>
        {[{ name: '视频', items: readout.clips.map(c => ({ id: c.id, start: c.start, end: c.start + c.duration, label: c.unit_id })) }, { name: '旁白', items: readout.clips.filter(c => c.narration).map(c => ({ id: c.id, start: c.narration!.start, end: c.narration!.end ?? c.start + c.duration, label: c.unit_id })) }, { name: '字幕', items: cues.map((c, i) => ({ id: String(i), ...c, label: c.text })) }, { name: '背景音乐', items: readout.bgm.map(c => ({ ...c, label: c.name ?? c.bgm_id })) }].map(track => <div key={track.name}><span>{t(track.name)}</span><div className="relative mt-1 h-8 rounded bg-canvas-card">{track.items.map(item => <button title={item.label} key={item.id} onClick={() => playback.seek(item.start)} className="absolute h-8 truncate rounded border border-canvas-border bg-canvas-hover px-2 text-left" style={{ left: `${item.start / duration * 100}%`, width: `${Math.max(0.2, (item.end - item.start) / duration * 100)}%` }}>{item.label}</button>)}</div></div>)}
        <div className="pointer-events-none absolute bottom-2 top-6 border-l-2 border-[var(--brand-light)]" style={{ left: `calc(${playback.t / duration * 100}% + ${12 - playback.t / duration * 24}px)` }} />
      </div>
    </div>
    {!!readout.issues.length && <details className="m-3 text-xs"><summary>{t('剪辑检查')} · {readout.issues.length}</summary>{readout.issues.map((issue, i) => <p className="mt-2" key={i}>{issue.unit_id} · {t(issueLabels[issue.code] ?? issue.code)} · {t(issue.severity === 'blocking' ? '需要修复' : issue.severity === 'warning' ? '请留意' : '提示')}</p>)}</details>}
  </div>;
}
