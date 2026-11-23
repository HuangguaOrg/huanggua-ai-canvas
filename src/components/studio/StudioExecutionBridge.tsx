import { useEffect } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { useHuangguaAccountStore } from '../../store/useHuangguaAccountStore';
import { pollStudioExecutions } from '../../services/studioExecutionService';

/** Remains mounted across modes so result delivery does not depend on the active view. */
export default function StudioExecutionBridge() {
  const phase = useHuangguaAccountStore(s => s.phase);
  const mode = useAppStore(s => s.clientWorkspaceMode);
  const loaded = useAppStore(s => s.studioLoad);
  useEffect(() => {
    if (phase !== 'connected') { void useAppStore.getState().disconnectStudio(); return; }
    if (mode === 'drama' && loaded === 'ready' && useAppStore.getState().studioConnection === 'idle') void useAppStore.getState().connectStudio();
  }, [phase, mode, loaded]);
  useEffect(() => {
    const timer = setInterval(() => { void pollStudioExecutions(); }, 4000);
    return () => clearInterval(timer);
  }, []);
  return null;
}
