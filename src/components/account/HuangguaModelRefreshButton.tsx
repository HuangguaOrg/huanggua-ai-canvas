import { RefreshCw } from 'lucide-react';
import { useT } from '../../i18n';
import { useAppStore } from '../../store/useAppStore';
import { useHuangguaAccountStore } from '../../store/useHuangguaAccountStore';
import { workspaceError } from '../../services/studioWorkspaceService';

/** Both workspaces refresh the same account-owned model catalog. */
export default function HuangguaModelRefreshButton({ menuItem = false }: { menuItem?: boolean } = {}) {
  const t = useT();
  const busy = useHuangguaAccountStore(s => s.busy);
  const refreshingStudio = useAppStore(s => s.studioModelsRefreshing);
  const refreshing = busy || refreshingStudio;
  const refresh = async () => {
    const account = useHuangguaAccountStore.getState();
    if (account.busy || useAppStore.getState().studioModelsRefreshing) return;
    if (!account.hasSession) { account.setDialogOpen(true); return; }
    await account.refresh();
    const latest = useHuangguaAccountStore.getState();
    const app = useAppStore.getState();
    if (latest.error || latest.phase !== 'connected') {
      app.showToast(t('模型列表更新失败，请在账号窗口查看原因并重试。'), 'error');
      latest.setDialogOpen(true);
    } else if (app.studioModelRefreshError) {
      app.showToast(`${t('画布模型已更新。')}${t(workspaceError(app.studioModelRefreshError))}`, 'error');
    } else {
      app.showToast(t('模型列表已更新'), 'success');
    }
  };
  return <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm nodrag nopan"
    role={menuItem ? 'menuitem' : undefined} tabIndex={menuItem ? -1 : undefined}
    data-model-menu-control={menuItem ? '' : undefined}
    disabled={refreshing} aria-busy={refreshing} title={t('获取黄瓜 AI 账号最新可用模型')}
    onClick={() => void refresh()}>
    <RefreshCw size={13} aria-hidden="true" className={refreshing ? 'animate-spin motion-reduce:animate-none' : undefined} />
    {t(refreshing ? '正在更新模型…' : '刷新模型列表')}
  </button>;
}
