import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { studioWorkspace, workspaceError, type StudioScope } from '../../services/studioWorkspaceService';

/** Identity-bound results; stale responses never overwrite another episode or selection. */
export function useWorkspaceQuery<T>(scope: StudioScope, action: string, id?: string, enabled = true) {
  const ready = useAppStore(s => s.studioConnection === 'ready');
  const [tick, setTick] = useState(0);
  const key = `${scope.projectId}/${scope.episodeId}/${action}/${id ?? ''}`;
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>();
  const refresh = useCallback(() => setTick(n => n + 1), []);
  useEffect(() => {
    if (!ready || !enabled) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const data = await studioWorkspace<T>({ projectId: scope.projectId, episodeId: scope.episodeId }, action, { id });
        if (active) setState(previous => previous?.key === key && !previous.error && JSON.stringify(previous.data) === JSON.stringify(data) ? previous : { key, data });
      } catch (error) { if (active) setState(previous => ({ key, data: previous?.key === key ? previous.data : undefined, error: workspaceError(error) })); }
      if (active) timer = setTimeout(() => void read(), 8000);
    };
    void read();
    return () => { active = false; clearTimeout(timer); };
  }, [scope.projectId, scope.episodeId, action, id, enabled, ready, key, tick]);
  return { data: state?.key === key ? state.data : undefined, error: state?.key === key ? state.error : undefined, refresh, ready };
}
