import { useCallback, useEffect, useState } from 'react';
import type { StudioEpisode, StudioProject } from '../../types/studio';
import { useAppStore } from '../../store/useAppStore';
import { studioWorkspace, uploadStudioLocalFile, workspaceError } from '../../services/studioWorkspaceService';
import { studioRequest, pollStudioExecutions } from '../../services/studioExecutionService';
import { useWorkspaceQuery } from './useWorkspaceQuery';
import ModalOverlay from '../shared/ModalOverlay';
import { StudioCurrentStyleSummary, StudioStylePicker } from './StudioStylePicker';
import {
  findStyleTemplate,
  hasProjectStyleConfigured,
  isStyleDraftComplete,
  type StudioStylePickerValue,
} from './styleTemplates';
import StudioRatioPicker from './StudioRatioPicker';
import {
  draftFromStoredStudioRatio,
  formatStudioRatioBadge,
  resolveStudioRatioDraft,
  type StudioRatioDraft,
} from './studioRatios';

export interface ProductionReply { rejected?: boolean; diagnostic?: unknown; decision?: string; [key: string]: unknown }
const problemText: Record<string, string> = {
  reference_asset_missing: '正文引用的素材缺少参考图，请先上传或生成对应素材图片。',
  reference_capability_changed: '参考图尚未齐备，当前生成方式发生变化。补齐参考图后再检查。',
  video_capability_missing_i2v: '当前模型不支持无参考图的生成方式，请补齐参考图或更换视频模型。',
  reference_duration_confirmation_required: '模型请求时长与计划时长不同，请确认所列时长档位。',
  reference_supported_durations_missing: '无法确定模型支持的时长，请检查视频模型配置。',
  reference_unit_needs_replan: '这个单元需要重新规划后才能生成。',
};
export function Feedback({ value }: { value: unknown }) {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number') return <p className="whitespace-pre-wrap break-words text-xs leading-6">{value}</p>;
  if (Array.isArray(value)) return <div className="space-y-2">{value.map((v, i) => <Feedback key={i} value={v} />)}</div>;
  if (typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const visible = ['text', 'message', 'reason', 'description', 'unavailable', 'warnings', 'problems', 'blockers', 'diagnostic', 'script_overwrite', 'prompt', 'rendered_prompt', 'utterances', 'items', 'units', 'targets', 'request_duration', 'script_duration', 'enqueue_failures'];
  const entries = Object.entries(row).filter(([key]) => visible.includes(key));
  return <div className="space-y-1">{entries.length ? entries.map(([key, v]) => <Feedback key={key} value={v} />) : <p className="text-xs">{typeof row.code === 'string' && problemText[row.code] || '请检查素材和生成条件。'}</p>}</div>;
}

interface RemoteProjectSettings {
  brief?: string;
  target_duration?: number;
  style?: string;
  style_template_id?: string | null;
  style_image?: string | null;
  style_description?: string | null;
  aspect_ratio?: string;
  desktop_custom_resolution?: string | null;
  episodes?: { script_file?: string }[];
}

export default function StudioProductionSetup({ project, episode }: { project: StudioProject; episode: StudioEpisode }) {
  const scope = { projectId: project.id, episodeId: episode.id };
  const query = useWorkspaceQuery<{ project?: RemoteProjectSettings | null }>(scope, 'project');
  const execution = useAppStore(s => s.studioExecutions[`${project.id}/${episode.id}`]);
  const setProjectStyleTemplate = useAppStore(s => s.setStudioProjectStyleTemplate);
  const setProjectRatio = useAppStore(s => s.setStudioProjectRatio);
  const [editing, setEditing] = useState(false);
  const [brief, setBrief] = useState('');
  const [duration, setDuration] = useState(30);
  const [ratioDraft, setRatioDraft] = useState<StudioRatioDraft>(() => draftFromStoredStudioRatio(project.aspectRatio ?? '9:16', project.customResolution ?? null));
  const [styleDraft, setStyleDraft] = useState<StudioStylePickerValue>({
    mode: 'template',
    templateId: null,
    activeCategory: 'live',
    uploadedFile: null,
    uploadedPreview: null,
  });
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [generate, setGenerate] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reply, setReply] = useState<ProductionReply>();
  const [revision, setRevision] = useState<string>();

  const ad = project.contentMode === 'ad';
  const remote = query.data?.project;
  const effectiveTemplateId = remote ? (remote.style_template_id ?? null) : (project.styleTemplateId ?? null);
  const effectiveRatio = remote?.aspect_ratio ?? project.aspectRatio ?? '9:16';
  const effectiveCustomRes = remote ? (remote.desktop_custom_resolution ?? null) : (project.customResolution ?? null);
  const styleImageName = remote?.style_image ?? '';
  const styleArtifact = styleImageName ? (execution?.artifacts ?? []).find(a => a.name === styleImageName) : undefined;
  const styleReady = hasProjectStyleConfigured(remote, project.styleTemplateId);
  const resolvedRatio = resolveStudioRatioDraft(ratioDraft);

  const openEditor = useCallback(() => {
    const p = query.data?.project;
    const tplId = p ? (p.style_template_id ?? null) : (project.styleTemplateId ?? null);
    const tpl = findStyleTemplate(tplId);
    const savedStyleImg = p?.style_image ? (execution?.artifacts ?? []).find(a => a.name === p.style_image)?.url ?? null : null;
    setBrief(p?.brief ?? '');
    setDuration(p?.target_duration ?? 30);
    setRatioDraft(
      draftFromStoredStudioRatio(
        p?.aspect_ratio ?? project.aspectRatio ?? '9:16',
        p ? (p.desktop_custom_resolution ?? null) : (project.customResolution ?? null),
      ),
    );
    if (p?.style_image) {
      setStyleDraft({
        mode: 'custom',
        templateId: null,
        activeCategory: 'live',
        uploadedFile: null,
        uploadedPreview: savedStyleImg ?? 'local-saved',
      });
    } else {
      setStyleDraft({
        mode: 'template',
        templateId: tpl?.id ?? null,
        activeCategory: tpl?.category ?? 'live',
        uploadedFile: null,
        uploadedPreview: null,
      });
    }
    setError('');
    setEditing(true);
  }, [query.data?.project, project.styleTemplateId, project.aspectRatio, project.customResolution, execution?.artifacts]);

  useEffect(() => {
    const handler = () => openEditor();
    window.addEventListener('studio-open-style-dialog', handler);
    return () => window.removeEventListener('studio-open-style-dialog', handler);
  }, [openEditor]);

  const initialize = () => studioRequest('workspace', {
    ...scope,
    action: 'initialize',
    title: project.name,
    models: episode.models ?? {},
    ...(styleDraft.mode === 'template' && styleDraft.templateId ? { styleTemplateId: styleDraft.templateId } : {}),
  });

  const save = async () => {
    if (!resolvedRatio.valid) {
      setError(resolvedRatio.error ?? '请检查画幅与自定义分辨率设置。');
      return;
    }
    if (!isStyleDraftComplete(styleDraft)) {
      setError('请选择一个画面风格模版，或上传一张风格参考图（两者必选其一）。');
      return;
    }
    setBusy(true); setError(''); setUploadPercent(null);
    try {
      const basePatch: Record<string, unknown> = {
        aspect_ratio: resolvedRatio.aspectRatio,
        custom_resolution: resolvedRatio.customResolution,
        ...(ad ? { brief, target_duration: duration } : {}),
      };
      if (styleDraft.mode === 'template' && styleDraft.templateId) {
        await studioWorkspace(scope, 'project_settings', {
          data: {
            ...basePatch,
            style_template_id: styleDraft.templateId,
            clear_style_image: true,
          },
        });
        setProjectStyleTemplate(project.id, styleDraft.templateId);
      } else {
        await studioWorkspace(scope, 'project_settings', { data: basePatch });
        if (styleDraft.uploadedFile) {
          await uploadStudioLocalFile(scope, 'style_image', styleDraft.uploadedFile, {
            onProgress: setUploadPercent,
          });
        }
        setProjectStyleTemplate(project.id, null);
      }
      setProjectRatio(project.id, resolvedRatio.aspectRatio, resolvedRatio.customResolution);
      setEditing(false);
      query.refresh();
      await pollStudioExecutions();
    } catch (e) {
      setError(workspaceError(e));
    } finally {
      setBusy(false);
      setUploadPercent(null);
    }
  };

  const run = async () => {
    if (!styleReady) {
      openEditor();
      return;
    }
    setBusy(true); setError('');
    try {
      if (!query.data?.project) await initialize();
      const result = await studioWorkspace<ProductionReply>(scope, 'ad_generate', { data: { instructions, regenerate: !!query.data?.project?.episodes?.[0]?.script_file, ...(revision ? { overwrite_revision: revision } : {}) } });
      setReply(result);
      const overwrite = (result.diagnostic as { script_overwrite?: { revision?: string } })?.script_overwrite;
      setRevision(overwrite?.revision);
      if (!result.rejected) { setGenerate(false); setError('广告脚本任务已提交，可在制作进度中查看。'); query.refresh(); await pollStudioExecutions(); }
    } catch (e) { setError(workspaceError(e)); } finally { setBusy(false); }
  };

  const draftReady = isStyleDraftComplete(styleDraft);

  return <section className="space-y-3 rounded-lg border border-canvas-border bg-canvas-surface p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-medium">{ad ? '广告 brief 与制作设置' : '项目设置与画面风格'}</h3>
      <span className="text-xs text-canvas-text-muted">{project.generationMode === 'reference_video' ? '参考生视频' : '分镜生视频'} · 画幅 {formatStudioRatioBadge(effectiveRatio, effectiveCustomRes)}</span>
    </div>
    <StudioCurrentStyleSummary
      templateId={effectiveTemplateId}
      hasStyleImage={Boolean(styleImageName)}
      styleImageUrl={styleImageName ? (styleArtifact?.url ?? null) : null}
      styleDescription={remote?.style_description}
      legacyStyleText={!effectiveTemplateId && !styleImageName ? remote?.style : null}
    />
    {ad && <p className="whitespace-pre-wrap text-sm leading-7">{remote?.brief || '填写广告 brief 或添加商品素材，再生成广告脚本。'}</p>}
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        className={`ui-btn ui-btn--sm ${styleReady ? '' : 'ui-btn--primary'}`}
        disabled={!query.ready}
        onClick={openEditor}
      >
        {styleReady ? '更换风格 / 制作设置' : '选择画面风格（必选）'}
      </button>
      {ad && <button type="button" className="ui-btn ui-btn--primary ui-btn--sm" disabled={!query.ready} onClick={() => { if (!styleReady) { openEditor(); return; } setReply(undefined); setRevision(undefined); setError(''); setGenerate(true); }}>AI 生成广告脚本</button>}
    </div>
    {error && !editing && <p role="status" className="text-xs">{error}</p>}{query.error && <p role="alert" className="text-xs">{query.error}</p>}

    <ModalOverlay isOpen={editing} onClose={() => !busy && setEditing(false)} ariaLabel="制作设置" zIndex={450} className="studio-editor ui-scroll max-h-[88vh] w-[min(780px,94vw)] space-y-4 overflow-y-auto p-5">
      <form className="space-y-4" onSubmit={e => { e.preventDefault(); void save(); }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">制作设置</h2>
            <p className="mt-1 text-xs text-canvas-text-muted">为项目选择一个画面风格模版，或上传一张本地风格参考图，两者必选其一。</p>
          </div>
        </div>
        {ad && <><label className="block text-sm">广告 brief<textarea className="ui-input mt-2" rows={4} maxLength={20000} value={brief} onChange={e => setBrief(e.target.value)} /></label><label className="block text-sm">目标时长（秒）<input className="ui-input mt-2" type="number" min={1} max={3600} value={duration} onChange={e => setDuration(Number(e.target.value))} /></label></>}
        <StudioRatioPicker
          label="画幅 / 分辨率"
          ariaLabel="画幅"
          value={ratioDraft}
          onChange={setRatioDraft}
          disabled={busy}
          helperText="全剧共用，作为分镜图片、视频及导出成片的默认比例与分辨率。单镜头可单独调整；修改后不会自动重生成已有资源。"
        />
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">画面风格（必选模版或上传参考图）</span>
            {!draftReady && <span className="text-xs text-amber-400">尚未选择风格或上传参考图</span>}
          </div>
          <StudioStylePicker value={styleDraft} onChange={setStyleDraft} />
        </div>
        {error && <p role="alert" className="ui-alert text-xs">{error}</p>}
        <div className="flex items-center justify-end gap-2 border-t border-canvas-border pt-3">
          <button type="button" className="ui-btn" disabled={busy} onClick={() => setEditing(false)}>取消</button>
          <button type="submit" className="ui-btn ui-btn--primary" disabled={busy || !duration || !draftReady || !resolvedRatio.valid}>
            {uploadPercent !== null ? `本地保存参考图 ${uploadPercent}%…` : busy ? '保存中…' : '使用此风格并保存'}
          </button>
        </div>
      </form>
    </ModalOverlay>

    <ModalOverlay isOpen={generate} onClose={() => !busy && setGenerate(false)} ariaLabel="生成广告脚本" zIndex={450} className="studio-editor ui-scroll max-h-[85vh] w-[min(640px,90vw)] space-y-4 overflow-auto p-5"><h2>生成广告脚本</h2><p className="text-xs">根据 brief 和商品生成正式脚本，模型调用使用账号余额。</p><textarea className="ui-input" rows={5} aria-label="广告脚本附加要求" value={instructions} onChange={e => { setInstructions(e.target.value); setRevision(undefined); setReply(undefined); }} />{reply?.rejected && <div className="ui-alert"><Feedback value={reply.diagnostic} /></div>}{error && <p role="alert" className="text-xs">{error}</p>}<div className="flex gap-2"><button className="ui-btn ui-btn--primary" disabled={busy} onClick={() => void run()}>{revision ? '确认替换原脚本' : '确认生成'}</button><button className="ui-btn" disabled={busy} onClick={() => setGenerate(false)}>取消</button></div></ModalOverlay>
  </section>;
}
