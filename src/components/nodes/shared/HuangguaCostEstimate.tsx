/**
 * HuangguaCostEstimate — 在无限画布节点输入栏展示黄瓜 AI 图片与视频模型的收费标准与本次扣费金额。
 */
import { Icon } from '@iconify/react';
import { useT } from '../../../i18n';
import type { BaseNodeData } from '../../../types';
import { useAppStore } from '../../../store/useAppStore';
import { useHuangguaAccountStore } from '../../../store/useHuangguaAccountStore';
import {
  getCachedHuangguaLivePricing,
  quoteHuangguaNodeCost,
  resolveHuangguaNodeModel,
  useHuangguaLivePricing,
} from '../../../services/billing/huangguaPricing';

export default function HuangguaCostEstimate({ data }: { data: BaseNodeData }) {
  const t = useT();
  const config = useAppStore((state) => state.config);
  const balance = useHuangguaAccountStore((state) => state.account?.balance);
  const openAccountDialog = useHuangguaAccountStore((state) => state.setDialogOpen);
  const resolved = !data.workflowId && (data.type === 'ai-image' || data.type === 'ai-video')
    ? resolveHuangguaNodeModel(data.model, data.provider, config)
    : null;
  useHuangguaLivePricing(Boolean(resolved));

  if (!resolved) return null;
  const quote = quoteHuangguaNodeCost(data, config, getCachedHuangguaLivePricing());
  if (!quote) return null;

  const badgeText = quote.isAutoDuration ? `≤${quote.formattedAmount}` : quote.formattedAmount;
  const headline = quote.isAutoDuration
    ? t('预估上限 {amount}（{detail}）', { amount: quote.formattedAmount, detail: quote.breakdown })
    : t('本次收费 {amount}（{detail}）', { amount: quote.formattedAmount, detail: quote.breakdown });
  const footer = balance
    ? `${t('账户余额')} ${balance} · ${t('失败自动退回，点击查看账号')}`
    : t('失败自动退回，点击查看账号');
  const tooltip = `${headline}\n${footer}`;

  return (
    <button
      type="button"
      className="prompt-cost-pill nodrag nopan"
      data-tooltip={tooltip}
      aria-label={`${headline}，${footer}`}
      onClick={(event) => {
        event.stopPropagation();
        openAccountDialog(true);
      }}
    >
      <Icon icon="lucide:receipt-text" width="13" aria-hidden="true" />
      <span>{badgeText}</span>
    </button>
  );
}
