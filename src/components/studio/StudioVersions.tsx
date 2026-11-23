import { useState } from 'react';
import type { StudioArtifact } from '../../types/studio';
import { studioWorkspace, workspaceError, type StudioScope } from '../../services/studioWorkspaceService';
import { pollStudioExecutions } from '../../services/studioExecutionService';
import ModalOverlay from '../shared/ModalOverlay';
import { StudioArtifactGrid } from './StudioResults';

interface Version { version: number; timestamp?: string; created_at?: string; file?: string; prompt?: string; restorable?: boolean }
export default function StudioVersions({ scope, category, name, derivative, artifacts, onChange }: { scope: StudioScope; category: string; name: string; derivative?: string; artifacts: StudioArtifact[]; onChange?: () => void }) {
  const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [data, setData] = useState<{ current_version: number; versions: Version[] }>();
  const [selected, setSelected] = useState<number>(); const [confirm, setConfirm] = useState(false);
  const load = async () => {
    setOpen(true); setBusy(true); setError(''); setConfirm(false);
    try { const result = await studioWorkspace<{ current_version: number; versions: Version[] }>(scope, 'versions', { category, id: name, data: { derivative } }); setData(result); setSelected(result.current_version); }
    catch (e) { setError(workspaceError(e)); } finally { setBusy(false); }
  };
  const restore = async () => {
    setBusy(true); setError('');
    try { await studioWorkspace(scope, 'version_restore', { category, id: name, data: { version: selected, derivative } }); await pollStudioExecutions(); onChange?.(); await load(); }
    catch (e) { setError(workspaceError(e)); } finally { setBusy(false); }
  };
  const current = data?.versions.find(v => v.version === selected);
  return <><button type="button" className="ui-btn ui-btn--sm" onClick={() => void load()}>历史版本</button>
    <ModalOverlay isOpen={open} onClose={() => !busy && setOpen(false)} ariaLabel="资产历史版本" zIndex={500} className="ui-scroll max-h-[85vh] w-[min(720px,92vw)] space-y-3 overflow-auto p-3">
      <div className="flex justify-between gap-2"><h2>{name}{derivative ? ` / ${derivative}` : ''} · 历史版本</h2><button className="ui-btn" disabled={busy} onClick={() => setOpen(false)}>关闭</button></div>
      <p className="text-xs text-canvas-text-muted">当前版本 v{data?.current_version ?? '—'}。{['characters', 'scenes', 'props', 'products', 'character-derivative'].includes(category) ? '切换共享资产版本会影响全剧后续制作。' : '切换版本会更新当前单元的媒体。'}已有生成文件仍保留。</p>
      <div className="flex flex-wrap gap-2">{data?.versions.map(v => <button className={`ui-btn ${v.version === selected ? 'ui-btn--primary' : ''}`} key={v.version} onClick={() => { setSelected(v.version); setConfirm(false); }}>v{v.version}{v.version === data.current_version ? ' · 当前' : ''}</button>)}</div>
      {data && !data.versions.length && <p className="text-xs">暂无版本。上传或生成素材后会自动记录。</p>}
      {current && <><p className="text-xs">{current.created_at ?? current.timestamp}</p><StudioArtifactGrid artifacts={artifacts.filter(a => a.name === current.file)} />{current.prompt && <p className="max-h-36 overflow-auto whitespace-pre-wrap text-xs">{current.prompt}</p>}<button className="ui-btn ui-btn--primary" disabled={busy || selected === data?.current_version || current.restorable === false} onClick={() => setConfirm(true)}>切换到此版本</button></>}
      {confirm && <div className="ui-alert text-xs">确认将当前资源切换为 v{selected}？<button className="ui-btn ml-2" disabled={busy} onClick={() => void restore()}>确认切换</button><button className="ui-btn ml-2" disabled={busy} onClick={() => setConfirm(false)}>取消</button></div>}
      {error && <p role="alert" className="ui-alert text-xs">{error}</p>}
    </ModalOverlay>
  </>;
}
