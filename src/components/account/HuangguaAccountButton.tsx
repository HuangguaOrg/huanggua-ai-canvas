import { UserRound } from 'lucide-react';
import { useT } from '../../i18n';
import { useHuangguaAccountStore } from '../../store/useHuangguaAccountStore';

export default function HuangguaAccountButton({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const account = useHuangguaAccountStore((s) => s.account);
  const phase = useHuangguaAccountStore((s) => s.phase);
  const open = useHuangguaAccountStore((s) => s.setDialogOpen);
  return <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm shrink-0"
    onClick={() => open(true)} aria-label={t('黄瓜 AI 账号')}>
    <UserRound size={14} aria-hidden="true" />
    <span className="max-w-28 truncate">{compact ? t('账号') : account?.name || account?.username || t(phase === 'verification' ? '等待验证' : '登录黄瓜 AI')}</span>
  </button>;
}
