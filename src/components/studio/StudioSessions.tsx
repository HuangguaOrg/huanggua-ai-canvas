import { useState } from 'react';
import { History, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { studioWorkspace, workspaceError, type StudioScope } from '../../services/studioWorkspaceService';
import { pollStudioExecutions } from '../../services/studioExecutionService';
import { useWorkspaceQuery } from './useWorkspaceQuery';
import { useT } from '../../i18n';
import Select from '../shared/Select';
import ModalOverlay from '../shared/ModalOverlay';

export function StudioSessionHeaderActions({
  scope,
  disabled,
  open,
  onToggle,
}: {
  scope: StudioScope;
  disabled: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);

  const handleNewSession = async () => {
    if (disabled || busy) return;
    setBusy(true);
    try {
      await studioWorkspace(scope, 'session_new', {});
      await pollStudioExecutions();
    } catch {
      // Surface any error inside the session drawer if needed.
      if (!open) onToggle();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        className="ui-btn ui-btn--ghost ui-btn--sm px-1.5"
        title={t('新建会话')}
        aria-label={t('新建会话')}
        disabled={disabled || busy}
        onClick={() => void handleNewSession()}
      >
        <Plus size={14} />
      </button>
      <button
        type="button"
        className={`ui-btn ui-btn--ghost ui-btn--sm px-1.5 ${open ? 'is-active text-[var(--brand-light)]' : ''}`}
        title={t('会话历史')}
        aria-label={t('会话历史')}
        aria-expanded={open}
        onClick={onToggle}
      >
        <History size={14} />
      </button>
    </div>
  );
}

export default function StudioSessions({
  scope,
  disabled,
  open,
}: {
  scope: StudioScope;
  disabled: boolean;
  open: boolean;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const query = useWorkspaceQuery<{
    sessions: Array<{ id: string; title: string; status: string; created_at: string; superseded?: boolean }>;
    selected?: string;
  }>(scope, 'sessions', undefined, open);

  const act = async (action: string, id?: string) => {
    setBusy(true);
    setError('');
    try {
      await studioWorkspace(scope, action, { id });
      setConfirmDelete(false);
      await pollStudioExecutions();
      query.refresh();
    } catch (e) {
      setError(workspaceError(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open && !confirmDelete) return null;

  return (
    <>
      {open && (
        <div className="shrink-0 space-y-2 border-b border-canvas-border bg-canvas-card/40 px-3 py-2.5 text-xs">
          <div className="flex items-center gap-1.5">
            <Select
              className="min-w-0 flex-1"
              aria-label={t('选择历史会话')}
              disabled={disabled || busy}
              value={query.data?.selected ?? ''}
              options={[
                { value: '', label: t('新会话（空白上下文）') },
                ...(query.data?.sessions ?? []).map(s => ({
                  value: s.id,
                  label: `${s.superseded ? '改写前 · ' : ''}${s.title?.slice(0, 36) || t('会话')} · ${s.created_at?.slice(5, 16).replace('T', ' ') ?? ''}`,
                })),
              ]}
              onChange={id => void act(id ? 'session_select' : 'session_new', id)}
            />
            <button
              type="button"
              className="ui-btn ui-btn--ghost ui-btn--sm px-2"
              title={t('刷新')}
              aria-label={t('刷新')}
              onClick={query.refresh}
            >
              <RefreshCw size={13} />
            </button>
            <button
              type="button"
              className="ui-btn ui-btn--ghost ui-btn--sm px-2 text-[var(--danger-light)]"
              title={t('删除当前会话')}
              aria-label={t('删除会话')}
              disabled={disabled || busy || !query.data?.selected}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={13} />
            </button>
          </div>
          {(error || query.error) && (
            <p role="alert" className="text-[11px] text-[var(--danger-light)]">
              {t(error || query.error || '')}
            </p>
          )}
        </div>
      )}
      <ModalOverlay
        isOpen={confirmDelete}
        onClose={() => !busy && setConfirmDelete(false)}
        ariaLabel={t('删除会话')}
        zIndex={400}
        className="w-[min(400px,90vw)] space-y-4 p-5"
      >
        <p className="text-xs leading-6">{t('删除当前会话的对话记录？已生成的项目资产、脚本与视频资源仍保留。')}</p>
        <div className="flex justify-end gap-2">
          <button type="button" className="ui-btn ui-btn--sm" disabled={busy} onClick={() => setConfirmDelete(false)}>
            {t('取消')}
          </button>
          <button
            type="button"
            className="ui-btn ui-btn--primary ui-btn--sm"
            disabled={busy}
            onClick={() => void act('session_delete', query.data?.selected)}
          >
            {t('确认删除')}
          </button>
        </div>
        {error && (
          <p role="alert" className="text-xs text-[var(--danger-light)]">
            {t(error)}
          </p>
        )}
      </ModalOverlay>
    </>
  );
}
