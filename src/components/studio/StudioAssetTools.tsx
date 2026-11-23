import { useState } from 'react';
import type { StudioArtifact } from '../../types/studio';
import { studioWorkspace, workspaceError, type StudioScope } from '../../services/studioWorkspaceService';
import { pollStudioExecutions } from '../../services/studioExecutionService';
import ModalOverlay from '../shared/ModalOverlay';
import Select from '../shared/Select';
import StudioVersions from './StudioVersions';
import StudioUpload from './StudioUpload';
import { StudioArtifactGrid } from './StudioResults';

export default function StudioAssetTools({ scope, category, name, names, derivatives = {}, assetVideos = [], artifacts, refresh }: { scope: StudioScope; category: string; name: string; names: string[]; derivatives?: Record<string, { description?: string }>; assetVideos?: string[]; artifacts: StudioArtifact[]; refresh: () => void }) {
  const [mode, setMode] = useState<'merge' | 'derivative' | null>(null);
  const [target, setTarget] = useState(''); const [asDerivative, setAsDerivative] = useState(false);
  const [preview, setPreview] = useState<{ references: number; episodes: Array<{ episode: number }> }>();
  const [editing, setEditing] = useState(''); const [newName, setNewName] = useState(''); const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [remove, setRemove] = useState(false);
  const sheetKind = category === 'characters' ? 'character' : category === 'scenes' ? 'scene' : category === 'products' ? 'product' : 'prop';
  const act = async (action: string, data: Record<string, unknown>) => {
    setBusy(true); setError('');
    try {
      const result = await studioWorkspace<{ references: number; episodes: Array<{ episode: number }> }>(scope, action, { category, id: name, data });
      if (action === 'asset_merge' && data.dryRun) setPreview(result);
      else { setMode(null); refresh(); await pollStudioExecutions(); }
    } catch (e) { setError(workspaceError(e)); } finally { setBusy(false); }
  };
  const removeAssetVideo = async (relPath: string) => {
    setBusy(true); setError('');
    try {
      await studioWorkspace(scope, 'local_ref_remove', { id: `${category}/${name}`, data: { scopeKind: 'asset', path: relPath } });
      refresh(); await pollStudioExecutions();
    } catch (e) { setError(workspaceError(e)); } finally { setBusy(false); }
  };
  const saveDerivative = async () => {
    setBusy(true); setError('');
    try {
      if (editing && editing !== newName.trim()) {
        await studioWorkspace(scope, 'derivative_rename', { id: name, data: { derivative: editing, name: newName.trim() } });
        setEditing(newName.trim());
      }
      await studioWorkspace(scope, editing ? 'derivative_update' : 'derivative_create', { id: name, data: { derivative: newName.trim(), name: newName.trim(), description } });
      setMode(null); refresh(); await pollStudioExecutions();
    } catch (e) { setError(workspaceError(e)); } finally { setBusy(false); }
  };
  const editDerivative = (key = '') => { setMode('derivative'); setEditing(key); setNewName(key); setDescription(derivatives[key]?.description ?? ''); setError(''); setRemove(false); };
  return <div className="space-y-2">
    <div className="flex flex-wrap gap-2">
      <StudioUpload scope={scope} kind={sheetKind} name={name} label="上传本地资产图" accept=".png,.jpg,.jpeg,.webp" onComplete={refresh} />
      {category === 'characters' && <StudioUpload scope={scope} kind="character_ref" name={name} label="上传本地参考图" accept=".png,.jpg,.jpeg,.webp" onComplete={refresh} />}
      {category === 'products' && <StudioUpload scope={scope} kind="product_ref" name={name} label="上传商品参考图" accept=".png,.jpg,.jpeg,.webp" onComplete={refresh} />}
      <StudioUpload scope={scope} kind="asset_video_ref" category={category} name={name} label="上传本地参考视频" accept=".mp4,.mov,.m4v,.webm" onComplete={refresh} />
      {category === 'characters' && <StudioUpload scope={scope} kind="character_audio_ref" name={name} label="上传参考声音" accept=".wav,.mp3" onComplete={refresh} />}
      <StudioVersions scope={scope} category={category} name={name} artifacts={artifacts} onChange={refresh} />
      <button type="button" className="ui-btn ui-btn--sm" disabled={names.length < 2} onClick={() => { setMode('merge'); setTarget(names.find(n => n !== name) ?? ''); setPreview(undefined); setError(''); }}>合并资产</button>
      {category === 'characters' && <button type="button" className="ui-btn ui-btn--sm" onClick={() => editDerivative()}>添加衍生形态</button>}
    </div>
    {assetVideos.length > 0 && <div className="space-y-2 rounded border border-canvas-border bg-canvas-card p-2 text-xs">
      <p className="text-[11px] text-canvas-text-secondary">已保存的本地资产参考视频</p>
      <div className="flex flex-wrap gap-2">{assetVideos.map(path => {
        const art = artifacts.find(a => a.name === path);
        return <div key={path} className="w-44 space-y-1">{art?.url ? <video className="h-24 w-44 rounded bg-canvas-bg object-contain" src={art.url} controls preload="metadata" /> : <span className="block truncate text-[10px]">{path.split('/').at(-1)}</span>}<button type="button" className="ui-btn ui-btn--ghost ui-btn--sm w-full" disabled={busy} onClick={() => void removeAssetVideo(path)}>移除绑定</button></div>;
      })}</div>
    </div>}
    {Object.entries(derivatives).map(([key, value]) => {
      const derivSheet = `characters/derivatives/${name}/${key}.png`;
      return <div key={key} className="space-y-2 rounded border border-canvas-border p-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex-1 font-medium">{name} / {key}</span>
          <StudioUpload scope={scope} kind="character_derivative" name={name} derivative={key} label="上传形态图片" accept=".png,.jpg,.jpeg,.webp" onComplete={refresh} />
          <button type="button" className="ui-btn ui-btn--sm" onClick={() => editDerivative(key)}>编辑形态</button>
          <StudioVersions scope={scope} category="character-derivative" name={name} derivative={key} artifacts={artifacts} onChange={refresh} />
        </div>
        <p className="whitespace-pre-wrap text-canvas-text-secondary">{value.description}</p>
        <StudioArtifactGrid artifacts={artifacts.filter(a => a.name === derivSheet)} />
      </div>;
    })}
    <ModalOverlay isOpen={!!mode} onClose={() => !busy && setMode(null)} ariaLabel={mode === 'merge' ? '合并共享资产' : '编辑衍生形态'} zIndex={500} className="studio-editor w-[min(560px,92vw)] space-y-3 p-3">
      <h2>{mode === 'merge' ? `将「${name}」并入其他资产` : `${name} · 衍生形态`}</h2>
      {mode === 'merge' ? <><Select aria-label="保留的资产" value={target} options={names.filter(n => n !== name).map(n => ({ value: n, label: n }))} onChange={v => { setTarget(v); setPreview(undefined); }} />{category === 'characters' && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={asDerivative} onChange={e => { setAsDerivative(e.target.checked); setPreview(undefined); }} />将来源角色保留为目标角色的衍生形态</label>}<p className="text-xs">合并会更新全剧脚本引用，保留目标资产及来源别名。先查看影响，再确认执行。</p>{preview && <p className="ui-alert text-xs">影响 {preview.references} 处引用，涉及分集：{preview.episodes.map(e => e.episode).join('、') || '无'}。</p>}<button className="ui-btn ui-btn--primary" disabled={busy || !target} onClick={() => void act('asset_merge', { target, asDerivative, dryRun: !preview })}>{preview ? '确认合并' : '查看影响'}</button></>
        : <><label className="block text-xs">形态名称<input className="ui-input mt-2" value={newName} onChange={e => setNewName(e.target.value)} /></label><label className="block text-xs">相对本体的变化<textarea className="ui-input mt-2" rows={4} value={description} onChange={e => setDescription(e.target.value)} /></label><div className="flex gap-2"><button className="ui-btn ui-btn--primary" disabled={busy || !newName.trim()} onClick={() => void saveDerivative()}>保存形态</button>{editing && <button className="ui-btn" disabled={busy} onClick={() => setRemove(true)}>删除形态</button>}</div>{remove && <div className="ui-alert text-xs">将删除此形态及其版本记录。<button className="ui-btn ml-2" disabled={busy} onClick={() => void act('derivative_delete', { derivative: editing })}>确认删除形态</button></div>}</>}
      {error && <p role="alert" className="ui-alert text-xs">{error}</p>}<button className="ui-btn" disabled={busy} onClick={() => setMode(null)}>取消</button>
    </ModalOverlay>
  </div>;
}
