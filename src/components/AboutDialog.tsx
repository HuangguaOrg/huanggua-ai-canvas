import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@iconify/react';
import { useAppVersion } from '../hooks/useAppVersion';
import { useAppStore } from '../store/useAppStore';
import { checkForUpdate, downloadAndInstallUpdate, isAppUpdateRunning, updateCheckErrorMessage } from '../services/updateService';
import { useT } from '../i18n';
import { openStyleGuideWindow } from '../utils/styleGuideWindow';
import ModalOverlay from './shared/ModalOverlay';
import DownloadProgress from './shared/DownloadProgress';
import AnimatedButton from './shared/AnimatedButton';

/** 「关于」弹窗里连点 logo 打开样式预览窗口：阈值与连点重置间隔 */
const STYLE_GUIDE_LOGO_TAPS = 4;
const STYLE_GUIDE_LOGO_RESET_MS = 1200;

export default function AboutDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const t = useT();
  const appVersion = useAppVersion();
  const logoTapsRef = useRef(0);
  const logoTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'checking' | 'no-update' | 'available' | 'updating' | 'error'>('idle');
  const [updateMsg, setUpdateMsg] = useState('');
  const [updateVersion, setUpdateVersion] = useState('');
  const appUpdateProgress = useAppStore((state) => state.appUpdateProgress);
  const updating = isAppUpdateRunning(appUpdateProgress);

  const handleCheckUpdate = async () => {
    if (isAppUpdateRunning(useAppStore.getState().appUpdateProgress)) return;
    setUpdateStatus('checking');
    setUpdateMsg('');
    setUpdateVersion('');
    useAppStore.setState({ appUpdateProgress: null });
    try {
      const result = await checkForUpdate({ manual: true });
      if (result.available) {
        setUpdateStatus('available');
        setUpdateVersion(result.version);
        setUpdateMsg(t('发现新版本 v{version}', { version: result.version }));
      } else {
        setUpdateStatus('no-update');
        setUpdateMsg(t('已是最新版本'));
      }
    } catch (error) {
      setUpdateStatus('error');
      setUpdateMsg(t(updateCheckErrorMessage(error)));
    }
  };

  const handleDownloadUpdate = async () => {
    setUpdateStatus('updating');
    setUpdateMsg(t('正在下载更新...'));
    const ok = await downloadAndInstallUpdate(useAppStore.getState().setAppUpdateProgress);
    const progress = useAppStore.getState().appUpdateProgress;
    setUpdateStatus(ok || progress?.phase === 'no-update' ? 'no-update' : 'error');
    setUpdateMsg(t(progress?.message ?? '下载失败，请稍后重试'));
  };

  const handleLogoClick = useCallback(() => {
    const taps = logoTapsRef.current + 1;
    logoTapsRef.current = taps;
    if (logoTapTimerRef.current) clearTimeout(logoTapTimerRef.current);

    if (taps >= STYLE_GUIDE_LOGO_TAPS) {
      logoTapsRef.current = 0;
      logoTapTimerRef.current = null;
      onClose();
      void openStyleGuideWindow();
      useAppStore.getState().showToast(t('已打开样式预览窗口'));
      return;
    }

    logoTapTimerRef.current = setTimeout(() => {
      logoTapsRef.current = 0;
      logoTapTimerRef.current = null;
    }, STYLE_GUIDE_LOGO_RESET_MS);
  }, [onClose, t]);

  useEffect(() => () => {
    if (logoTapTimerRef.current) clearTimeout(logoTapTimerRef.current);
  }, []);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <ModalOverlay
      isOpen={isOpen}
      onClose={onClose}
      ariaLabel={t('关于黄瓜 AI 画布')}
      zIndex={450}
      className="w-[420px] max-h-[85vh] overflow-y-auto"
    >
      <div className="p-3 space-y-3">
        {/* Header */}
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={handleLogoClick}
            className="flex h-12 w-12 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-indigo-500/20 transition-transform active:scale-95"
            aria-label={t('黄瓜 AI 画布')}
          >
            <img src={`${import.meta.env.BASE_URL}huanggua-ai.png`} alt="" />
          </button>
          <div>
            <h2 className="text-lg font-semibold text-canvas-text">黄瓜 AI 画布</h2>
            <p className="text-xs text-canvas-text-secondary">v{appVersion} · {t('开发预览版')}</p>
            <button
              type="button"
              onClick={updateStatus === 'available' ? handleDownloadUpdate : handleCheckUpdate}
              disabled={updateStatus === 'checking' || updateStatus === 'updating' || updating}
              className="mt-1 inline-flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300 disabled:text-canvas-text-muted transition-colors"
            >
              {updateStatus === 'checking' ? (
                <>
                  <Icon icon="svg-spinners:90-ring" width="12" height="12" />
                  {t('检查中...')}
                </>
              ) : updateStatus === 'updating' || updating ? (
                <>
                  <Icon icon="svg-spinners:90-ring" width="12" height="12" />
                  {t(appUpdateProgress?.message ?? '下载中...')}
                </>
              ) : updateStatus === 'no-update' && updateMsg ? (
                updateMsg
              ) : updateStatus === 'available' ? (
                t('发现 v{version}，点击更新', { version: updateVersion })
              ) : updateStatus === 'error' ? (
                t('重新检查更新')
              ) : (
                t('检查更新')
              )}
            </button>
          </div>
        </div>

        {updateStatus === 'error' && updateMsg && <p role="alert" className="text-xs text-danger-light">{updateMsg}</p>}

        {appUpdateProgress?.phase === 'downloading' ? (
          <DownloadProgress
            downloadedBytes={appUpdateProgress.downloadedBytes}
            totalBytes={appUpdateProgress.totalBytes}
            label={t(appUpdateProgress.message)}
          />
        ) : appUpdateProgress ? (
          <p role="status" className={`text-xs ${appUpdateProgress.phase === 'error' ? 'text-danger-light' : 'text-canvas-text-secondary'}`}>
            {t(appUpdateProgress.message)}
          </p>
        ) : null}

        {/* Description */}
        <p className="text-sm text-canvas-text-secondary leading-relaxed">
          {t('黄瓜 AI 画布 是一个智能多媒体创意画布，通过可视化节点编排的方式，调用多种 AI 模型来生成文本、图像、视频和音频内容。支持多厂商模型接入、ComfyUI 工作流、本地文件管理与实时协作。')}
        </p>

        {/* Feature list */}
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase text-canvas-text-muted">{t('核心能力')}</h3>
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: 'AI 文本生成', color: 'bg-indigo-500/20 text-indigo-400' },
              { label: 'AI 图像生成', color: 'bg-green-500/20 text-green-400' },
              { label: 'AI 视频生成', color: 'bg-blue-500/20 text-blue-400' },
              { label: 'AI 音频生成', color: 'bg-orange-500/20 text-orange-400' },
              { label: 'ComfyUI 工作流', color: 'bg-purple-500/20 text-purple-400' },
              { label: '节点分组管理', color: 'bg-cyan-500/20 text-cyan-400' },
              { label: '画布无限缩放', color: 'bg-pink-500/20 text-pink-400' },
              { label: '本地文件读写', color: 'bg-yellow-500/20 text-yellow-400' },
            ].map(({ label, color }) => (
              <span
                key={label}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium ${color}`}
              >
                {t(label)}
              </span>
            ))}
          </div>
        </div>

        {/* Divider */}
        <div className="border-t border-canvas-border" />

        {/* Tech stack */}
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase text-canvas-text-muted">{t('技术栈')}</h3>
          <div className="flex flex-wrap gap-1.5">
            {['Tauri 2', 'React 19', 'React Flow 12', 'TypeScript', 'Zustand 5', 'Tailwind CSS 3', 'Vite 8'].map((tech) => (
              <span key={tech} className="px-2.5 py-1 rounded-md bg-canvas-hover text-xs text-canvas-text-secondary">
                {tech}
              </span>
            ))}
          </div>
        </div>

        {/* Community */}
        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase text-canvas-text-muted">{t('社区')}</h3>
          <div className="flex flex-col gap-2">
            <a
              href="https://huanggua.my"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-canvas-hover hover:bg-canvas-border transition-colors text-xs text-canvas-text-secondary hover:text-canvas-text"
            >
              {t('黄瓜 AI 官网')}
            </a>
          </div>
        </div>

        {/* Footer */}
        <div className="pt-2 flex items-center justify-between border-t border-canvas-border">
          <span className="text-[11px] text-canvas-text-muted">© 2026 黄瓜 AI</span>
          <AnimatedButton
            type="button"
            className="px-3 py-1.5 text-xs font-medium text-canvas-text bg-canvas-hover hover:bg-canvas-border rounded-lg transition-colors"
            onClick={onClose}
          >
            {t('知道了')}
          </AnimatedButton>
        </div>
      </div>
    </ModalOverlay>,
    document.body,
  );
}
