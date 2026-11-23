/**
 * 黄瓜 AI 使用说明；沿用已确认状态，避免升级重复打扰。
 */
import { Icon } from '@iconify/react';
import { useT } from '../i18n';
import ModalOverlay from './shared/ModalOverlay';

interface FreeDistributionNoticeDialogProps {
  onAcknowledge: () => void;
}

export default function FreeDistributionNoticeDialog({
  onAcknowledge,
}: FreeDistributionNoticeDialogProps) {
  const t = useT();

  return (
    <ModalOverlay
      isOpen
      onClose={onAcknowledge}
      closeOnBackdrop={false}
      ariaLabel={t('黄瓜 AI 使用说明')}
      className="w-[min(520px,calc(100vw-24px))]"
    >
      <header className="flex items-start gap-3 border-b border-canvas-border px-5 py-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--warning-bg)] text-[var(--warning-light)]">
          <Icon icon="mdi:shield-alert-outline" width="22" height="22" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <span className="ui-badge ui-badge--warning mb-1.5">{t('重要提醒')}</span>
          <h2 className="text-base font-semibold text-canvas-text">
            {t('欢迎使用黄瓜 AI')}
          </h2>
          <p className="mt-1 text-xs leading-5 text-canvas-text-secondary">
            {t('登录黄瓜 AI 账号，即可使用账号已开通的模型服务')}
          </p>
        </div>
      </header>

      <div className="space-y-3 px-5 py-4 text-sm leading-6 text-canvas-text-secondary">
        <p>
          {t('无限画布和短剧工作区共用黄瓜 AI 账号，生成的内容统一保存在个人资源库。')}
        </p>

        <section className="ui-alert ui-alert--warning">
          <Icon
            icon="mdi:alert-circle-outline"
            width="18"
            height="18"
            className="ui-alert__icon"
            aria-hidden="true"
          />
          <div className="ui-alert__body">
            <h3 className="ui-alert__title">{t('模型服务与用量')}</h3>
            <p>
              {t('图片、视频和对话生成会调用模型服务，具体可用模型、余额及计费以黄瓜 AI 账号页面为准。')}
            </p>
          </div>
        </section>

        <p className="font-medium text-canvas-text">
          {t('请通过黄瓜 AI 官方渠道管理账号和服务。')}
        </p>

        <div className="flex items-start gap-2 rounded-lg bg-canvas-hover/70 px-3 py-2.5 text-xs leading-5 text-canvas-text-muted">
          <Icon
            icon="mdi:information-outline"
            width="16"
            height="16"
            className="mt-0.5 shrink-0"
            aria-hidden="true"
          />
          <p>
            {t('项目与资源保存在本机。更换电脑或卸载前，请先导出并备份需要保留的内容。')}
          </p>
        </div>
      </div>

      <footer className="flex justify-end border-t border-canvas-border px-5 py-3.5">
        <button
          type="button"
          autoFocus
          onClick={onAcknowledge}
          className="ui-btn ui-btn--primary ui-btn--lg"
        >
          <Icon icon="mdi:check" width="16" height="16" aria-hidden="true" />
          {t('我知道了，继续使用')}
        </button>
      </footer>
    </ModalOverlay>
  );
}
