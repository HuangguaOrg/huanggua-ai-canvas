import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { studioRequest, pollStudioExecutions } from '../../services/studioExecutionService';
import { studioWorkspace, workspaceError } from '../../services/studioWorkspaceService';
import type { StudioArtifact, StudioEpisode, StudioProject } from '../../types/studio';
import { useWorkspaceQuery } from './useWorkspaceQuery';
import ModalOverlay from '../shared/ModalOverlay';
import { StudioArtifactGrid } from './StudioResults';
import StudioUpload from './StudioUpload';
import StudioAssetTools from './StudioAssetTools';

type Asset = { brand?: string; selling_points?: string[]; product_sheet?: string; description?: string; voice_style?: string; character_sheet?: string; scene_sheet?: string; prop_sheet?: string; reference_image?: string; reference_audio?: string; reference_images?: string[]; derivatives?: Record<string, { description?: string }> };
export default function StudioAssetEditor({ project, episode, category, artifacts }: { project: StudioProject; episode: StudioEpisode; category: string; artifacts: StudioArtifact[] }) {
  const t = useT(); const scope = { projectId: project.id, episodeId: episode.id };
  const query = useWorkspaceQuery<{ project: (Record<string, Record<string, Asset>> & { desktop_asset_videos?: Record<string, string[]> }) | null }>(scope, 'project');
  const refreshQuery = query.refresh;
  useEffect(() => { refreshQuery(); }, [artifacts.length, refreshQuery]);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState(''); const [description, setDescription] = useState(''); const [voice, setVoice] = useState('');
  const [brand, setBrand] = useState(''); const [selling, setSelling] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const entries = Object.entries(query.data?.project?.[category] ?? {});
  const assetVideosMap = query.data?.project?.desktop_asset_videos ?? {};
  const resolveCardArtifacts = (key: string, value: Asset) => {
    const primarySheet = (value.character_sheet || value.scene_sheet || value.prop_sheet || value.product_sheet || '').replace(/^\.\//, '');
    const extraRefs = [value.reference_image, value.reference_audio, ...(value.reference_images ?? [])]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .map(v => v.replace(/^\.\//, ''));
    return artifacts.filter(a => (primarySheet ? a.name === primarySheet : a.name.startsWith(`${category}/${key}.`)) || extraRefs.includes(a.name));
  };
  const assignedNames = new Set(entries.flatMap(([key, value]) => resolveCardArtifacts(key, value).map(a => a.name)));
  const open = (assetName: string, value?: Asset) => { setEditing(assetName); setName(assetName); setDescription(value?.description ?? ''); setVoice(value?.voice_style ?? ''); setBrand(value?.brand ?? ''); setSelling(value?.selling_points?.join('\n') ?? ''); setError(''); setConfirmDelete(false); };
  const ensureAssetSaved = async () => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('studio_invalid_request');
    if (editing === trimmed) return { name: trimmed };
    const data = { name: trimmed, description, ...(category === 'characters' ? { voice_style: voice } : category === 'products' ? { brand, selling_points: selling.split(/\r?\n/).map(s => s.trim()).filter(Boolean) } : {}) };
    await studioWorkspace(scope, editing ? 'asset_update' : 'asset_create', { category, id: trimmed, data });
    setEditing(trimmed);
    query.refresh();
    return { name: trimmed };
  };
  const act = async (remove = false) => {
    setBusy(true); setError('');
    try {
      if (!query.data?.project) await studioRequest('workspace', { ...scope, action: 'initialize', title: `${project.name} · ${episode.name}`, episodeTitle: episode.name, sourceText: episode.script, models: episode.models ?? {} });
      const data = { name: name.trim(), description, ...(category === 'characters' ? { voice_style: voice } : category === 'products' ? { brand, selling_points: selling.split(/\r?\n/).map(s => s.trim()).filter(Boolean) } : {}) };
      if (remove) await studioWorkspace(scope, 'asset_delete', { category, id: editing! });
      else {
        if (editing && editing !== name.trim()) {
          await studioWorkspace(scope, 'asset_rename', { category, id: editing, data: { name: name.trim(), dryRun: true } });
          await studioWorkspace(scope, 'asset_rename', { category, id: editing, data: { name: name.trim(), dryRun: false } });
          setEditing(name.trim());
        }
        await studioWorkspace(scope, editing ? 'asset_update' : 'asset_create', { category, id: name.trim(), data });
      }
      setEditing(null); query.refresh(); await pollStudioExecutions();
    } catch (e) { setError(workspaceError(e)); } finally { setBusy(false); }
  };
  const sheetKind = category === 'characters' ? 'character' : category === 'scenes' ? 'scene' : category === 'products' ? 'product' : 'prop';
  return <div className="space-y-4"><div className="flex items-center gap-3"><span className="flex-1 text-xs text-canvas-text-muted">{t('全剧共享资产 · 所有分集共用 · 本地上传直接保存在项目记录')}</span><button className="ui-btn ui-btn--sm" disabled={!query.ready} onClick={() => open('')}>{t('添加素材')}</button><button className="ui-btn ui-btn--ghost ui-btn--sm" onClick={query.refresh}>{t('刷新信息')}</button></div>
    {query.error && <p role="alert" className="ui-alert text-xs">{t(query.error)}</p>}
    <div className="grid gap-3 md:grid-cols-2">{entries.map(([key, value]) => {
      const cardArtifacts = resolveCardArtifacts(key, value);
      return <article key={key} className="space-y-3 rounded-lg border border-canvas-border bg-canvas-surface p-4"><div className="flex justify-between"><h2 className="text-sm font-medium">{key}</h2><button className="ui-btn ui-btn--sm" onClick={() => open(key, value)}>{t('编辑')}</button></div><p className="whitespace-pre-wrap text-xs leading-6 text-canvas-text-secondary">{value.description}</p>{value.voice_style && <p className="text-xs text-canvas-text-muted">{value.voice_style}</p>}{cardArtifacts.length > 0 && <StudioArtifactGrid artifacts={cardArtifacts} />}<StudioAssetTools scope={scope} category={category} name={key} names={entries.map(([n]) => n)} derivatives={value.derivatives} assetVideos={assetVideosMap[`${category}/${key}`] ?? []} artifacts={artifacts} refresh={query.refresh} /></article>;
    })}</div>
    <StudioArtifactGrid artifacts={artifacts.filter(a => !a.name.startsWith('versions/') && !a.name.startsWith('characters/derivatives/') && !a.name.startsWith('uploads/') && !assignedNames.has(a.name))} />
    <ModalOverlay isOpen={editing !== null} onClose={() => !busy && setEditing(null)} ariaLabel={t('编辑素材')} zIndex={400} className="studio-editor ui-scroll max-h-[90vh] w-[min(540px,90vw)] overflow-auto p-5"><form className="space-y-4" onSubmit={e => { e.preventDefault(); void act(); }}><h2>{t(editing ? '编辑素材' : '添加素材')}</h2><label className="block text-xs">{t('名称')}<input required maxLength={100} className="ui-input mt-2" value={name} onChange={e => setName(e.target.value)} /></label><label className="block text-xs">{t('描述')}<textarea rows={7} className="ui-input mt-2" value={description} onChange={e => setDescription(e.target.value)} /></label>{category === 'products' && <><label className="block text-xs">品牌<input className="ui-input mt-2" value={brand} onChange={e => setBrand(e.target.value)} /></label><label className="block text-xs">核心卖点<textarea className="ui-input mt-2" value={selling} onChange={e => setSelling(e.target.value)} /></label></>}{category === 'characters' && <label className="block text-xs">{t('声音风格')}<input className="ui-input mt-2" value={voice} onChange={e => setVoice(e.target.value)} /></label>}
      <div className="flex flex-wrap gap-2">
        <StudioUpload scope={scope} kind={sheetKind} name={editing || name.trim()} label="上传本地资产图" accept=".png,.jpg,.jpeg,.webp" disabled={!name.trim()} resolveTarget={ensureAssetSaved} onComplete={query.refresh} />
        {category === 'products' && <StudioUpload scope={scope} kind="product_ref" name={editing || name.trim()} label="上传商品参考图" accept=".png,.jpg,.jpeg,.webp" disabled={!name.trim()} resolveTarget={ensureAssetSaved} onComplete={query.refresh} />}
        {category === 'characters' && <><StudioUpload scope={scope} kind="character_ref" name={editing || name.trim()} label="上传参考图片" accept=".png,.jpg,.jpeg,.webp" disabled={!name.trim()} resolveTarget={ensureAssetSaved} onComplete={query.refresh} /><StudioUpload scope={scope} kind="character_audio_ref" name={editing || name.trim()} label="上传参考声音" accept=".wav,.mp3" disabled={!name.trim()} resolveTarget={ensureAssetSaved} onComplete={query.refresh} /></>}
        <StudioUpload scope={scope} kind="asset_video_ref" category={category} name={editing || name.trim()} label="上传本地参考视频" accept=".mp4,.mov,.m4v,.webm" disabled={!name.trim()} resolveTarget={ensureAssetSaved} onComplete={query.refresh} />
      </div>
      <div className="flex gap-2"><button className="ui-btn ui-btn--primary" disabled={busy || !name.trim()}>{t('保存')}</button><button type="button" className="ui-btn" disabled={busy} onClick={() => setEditing(null)}>{t('取消')}</button>{editing && <button type="button" className="ui-btn" disabled={busy} onClick={() => setConfirmDelete(!confirmDelete)}>{t('删除')}</button>}</div>{confirmDelete && <p className="ui-alert text-xs">{t('确认删除此素材？')}<button type="button" className="ui-btn ml-2" disabled={busy} onClick={() => void act(true)}>{t('确认删除')}</button></p>}{error && <p className="ui-alert text-xs" role="alert">{t(error)}</p>}
    </form></ModalOverlay>
  </div>;
}
