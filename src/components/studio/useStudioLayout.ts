import { useState, useSyncExternalStore } from 'react';

function readWidth(name: string, fallback: number, min: number, max: number) {
  try {
    const raw = localStorage.getItem(`huanggua-studio-${name}`);
    const value = raw === null ? fallback : Number(raw);
    return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
  } catch { return fallback; }
}
function remember(name: string, value: number) {
  try { localStorage.setItem(`huanggua-studio-${name}`, String(value)); } catch { /* Keep the current session usable. */ }
}
const query = '(max-width: 1279px)';
function subscribe(callback: () => void) {
  const media = matchMedia(query); media.addEventListener('change', callback);
  return () => media.removeEventListener('change', callback);
}
export function useStudioLayout() {
  const compact = useSyncExternalStore(subscribe, () => matchMedia(query).matches, () => false);
  const [sidebarWidth, setSidebar] = useState(() => readWidth('sidebar-width', 256, 200, 320));
  const [agentWidth, setAgent] = useState(() => readWidth('agent-width', 420, 320, 640));
  const [collapsed, setCollapsed] = useState(() => readWidth('sidebar-collapsed', 0, 0, 1) === 1);
  const [agentOpen, setAgentOpen] = useState(() => readWidth('agent-open', 1, 0, 1) === 1);
  return { compact, sidebarWidth, agentWidth, collapsed, agentOpen,
    setSidebarWidth: (value: number) => { setSidebar(value); remember('sidebar-width', value); },
    setAgentWidth: (value: number) => { setAgent(value); remember('agent-width', value); },
    setCollapsed: (value: boolean) => { setCollapsed(value); remember('sidebar-collapsed', Number(value)); },
    setAgentOpen: (value: boolean) => { setAgentOpen(value); remember('agent-open', Number(value)); },
  };
}
