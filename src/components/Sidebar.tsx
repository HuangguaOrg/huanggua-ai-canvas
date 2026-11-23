/**
 * 应用主侧栏，集中承载节点创建、项目入口、功能面板切换、更新状态与快捷操作。
 */
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { JSX } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Icon } from '@iconify/react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore, generateId } from '../store/useAppStore';
import { countUnreadDramaAssets } from '../store/store.dramaAssets';
import AboutDialog from './AboutDialog';
import type { NodeType } from '../types';
import { NODE_TYPE_CONFIG } from '../types';
import { importSourceFileToCanvas } from '../services/sourceFileImportService';
import { getCanvasPointerPosition } from '../services/canvasPointerService';
import { getPreferredNodeModel } from '../services/modelPreferenceService';
import { createUiNodeData } from '../services/uiNodeCreationData';
import AnimatedButton from './shared/AnimatedButton';
import LazyLoadBoundary, { LazyLoadFallback } from './shared/LazyLoadBoundary';
import ProjectLibraryModal from './ProjectLibraryModal';
import { openDetachedChatWindow } from '../services/chat/chatWindowLifecycle';
import { useT } from '../i18n';
import {
  createPluginNode,
  getAvailablePluginNodes,
} from '../services/plugins/pluginRuntime';

const HelpCenterDialog = lazy(() => import('./HelpCenterDialog'));

/**
 * Sidebar 侧边栏面板 — 左侧节点类型列表、上传入口、项目切换、拖拽添加节点
 */

/* ============================================
   Node picker menu items
   ============================================ */
const generationItems: {
  type: NodeType;
  label: string;
  sub: string;
  icon: JSX.Element;
}[] = [
  {
    type: 'ai-text',
    label: '生成文本',
    sub: 'AI 文本生成',
    icon: <Icon icon={NODE_TYPE_CONFIG['ai-text'].icon} width="18" height="18" />,
  },
  {
    type: 'ai-image',
    label: '生成图像',
    sub: 'AI 图像生成',
    icon: <Icon icon={NODE_TYPE_CONFIG['ai-image'].icon} width="18" height="18" />,
  },
  {
    type: 'ai-video',
    label: '生成视频',
    sub: 'AI 视频生成',
    icon: <Icon icon={NODE_TYPE_CONFIG['ai-video'].icon} width="18" height="18" />,
  },
  {
    type: 'ai-audio',
    label: '生成音频',
    sub: 'AI 音频生成',
    icon: <Icon icon={NODE_TYPE_CONFIG['ai-audio'].icon} width="18" height="18" />,
  },
  {
    type: 'ai-panorama',
    label: '生成360全景',
    sub: 'AI 全景图生成',
    icon: <Icon icon={NODE_TYPE_CONFIG['ai-panorama'].icon} width="18" height="18" />,
  },
  {
    type: 'ai-animation',
    label: '帧动画',
    sub: '2D 角色逐帧动画',
    icon: <Icon icon={NODE_TYPE_CONFIG['ai-animation'].icon} width="18" height="18" />,
  },
  {
    type: 'ai-director',
    label: '3D 导演台',
    sub: '运镜预演 · 截图供生视频',
    icon: <Icon icon={NODE_TYPE_CONFIG['ai-director'].icon} width="18" height="18" />,
  },
];

const resourceItems = [
  {
    key: 'upload',
    label: '上传文件',
    sub: '图片 / 视频 / 音频',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="17 8 12 3 7 8" />
        <line x1="12" y1="3" x2="12" y2="15" />
      </svg>
    ),
  },
];

/* ============================================
   Node Picker popup
   ============================================ */
function NodePicker({
  onEnter,
  onLeave,
}: {
  onEnter: () => void;
  onLeave: () => void;
}) {
  const t = useT();
  const { nodePickerOpen, closeNodePicker, addNode, showToast, installedPlugins } = useAppStore(
    useShallow((s) => ({
      nodePickerOpen: s.nodePickerOpen,
      closeNodePicker: s.closeNodePicker,
      addNode: s.addNode,
      showToast: s.showToast,
      installedPlugins: s.installedPlugins,
    })),
  );
  const pickerRef = useRef<HTMLDivElement>(null);
  const pluginNodes = getAvailablePluginNodes(installedPlugins);

  const handleAddNode = (type: NodeType) => {
    const isImage = type === 'ai-image';
    const isPanorama = type === 'ai-panorama';
    const isAnimation = type === 'ai-animation';
    const isDirector = type === 'ai-director';
    const nodeData = {
      ...createUiNodeData(type, t(NODE_TYPE_CONFIG[type]?.label || generationItems.find((m) => m.type === type)?.label || '节点')),
      nodeWidth: isAnimation || isDirector ? 320 : isPanorama ? 300 : 280,
      nodeHeight: isDirector ? 240 : isImage ? 158 : isAnimation ? 358 : isPanorama ? 200 : 160,
      ...(isPanorama ? { previewMode: 'image' as const } : {}),
    };
    if (!isDirector) Object.assign(nodeData, getPreferredNodeModel(type, useAppStore.getState()));
    const pos = getCanvasPointerPosition();
    addNode({
      id: `node-${generateId()}`,
      type,
      position: pos,
      data: nodeData,
    } as never);
    closeNodePicker();
  };

  const handleUploadFile = async () => {
    closeNodePicker();
    try {
      await importSourceFileToCanvas(getCanvasPointerPosition());
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('上传失败');
      showToast(msg, 'error');
    }
  };

  const handleAddPluginNode = (pluginNode: (typeof pluginNodes)[number]) => {
    addNode(createPluginNode(pluginNode, getCanvasPointerPosition()));
    closeNodePicker();
  };

  return (
    <AnimatePresence>
      {nodePickerOpen && (
        <motion.div
          ref={pickerRef}
          className="node-picker"
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
          initial={{ opacity: 0, scale: 0.95, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -4 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        >
      <div className="menu-section">
        <span className="menu-title">{t('画布自由生成')}</span>
        <div className="menu-rule" />
      </div>
      {generationItems.map(({ type, label, sub, icon }) => (
        <AnimatedButton
          key={type}
          scale={1.02}
          className="menu-row has-desc"
          onClick={() => {
            handleAddNode(type);
          }}
        >
          <div className="menu-ico">{icon}</div>
          <div className="menu-txt-wrap">
            <span className="menu-lbl">{t(label)}</span>
            <span className="menu-sub">{t(sub)}</span>
          </div>
        </AnimatedButton>
      ))}
      {pluginNodes.length > 0 && (
        <>
          <div className="menu-section">
            <span className="menu-title">{t('插件节点')}</span>
            <div className="menu-rule" />
          </div>
          {pluginNodes.map((pluginNode) => (
            <AnimatedButton
              key={`${pluginNode.pluginId}:${pluginNode.node.id}`}
              scale={1.02}
              className="menu-row has-desc"
              onClick={() => handleAddPluginNode(pluginNode)}
            >
              <div className="menu-ico">
                <Icon icon={pluginNode.node.icon} width="18" height="18" />
              </div>
              <div className="menu-txt-wrap">
                <span className="menu-lbl">{pluginNode.node.title}</span>
                <span className="menu-sub">{pluginNode.pluginName}</span>
              </div>
            </AnimatedButton>
          ))}
        </>
      )}
      <div className="menu-section">
        <span className="menu-title">{t('添加资源')}</span>
        <div className="menu-rule" />
      </div>
      {resourceItems.map(({ key, label, sub, icon }) => (
        <AnimatedButton key={key} scale={1.02} className="menu-row has-desc"
          onClick={async () => {
            if (key === 'upload') return handleUploadFile();
          }}
        >
          <div className="menu-ico">{icon}</div>
          <div className="menu-txt-wrap">
            <span className="menu-lbl">{t(label)}</span>
            <span className="menu-sub">{t(sub)}</span>
          </div>
        </AnimatedButton>
      ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ============================================
   Avatar / Settings dropdown menu
   ============================================ */
function AvatarMenu() {
  const t = useT();
  const { avatarMenuOpen, closeAvatarMenu, setSettingsOpen, helpOpen, setHelpOpen } = useAppStore(
    useShallow((s) => ({
      avatarMenuOpen: s.avatarMenuOpen,
      closeAvatarMenu: s.closeAvatarMenu,
      setSettingsOpen: s.setSettingsOpen,
      helpOpen: s.helpOpen,
      setHelpOpen: s.setHelpOpen,
    })),
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const [aboutOpen, setAboutOpen] = useState(false);

  useEffect(() => {
    if (!avatarMenuOpen) return;
    const handler = (e: MouseEvent) => {
      // Ignore clicks on the gear button itself
      const gearBtn = document.getElementById('btn-user-gear');
      if (gearBtn && gearBtn.contains(e.target as Node)) return;
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeAvatarMenu();
      }
    };
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, [avatarMenuOpen, closeAvatarMenu]);

  return (
    <>
      <AnimatePresence>
      {avatarMenuOpen && (
        <motion.div
          ref={menuRef}
          className="avatar-menu"
          initial={{ opacity: 0, scale: 0.95, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -4 }}
          transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        >
          <AnimatedButton
            type="button"
            className="avatar-menu-item"
            scale={1.02}
            onClick={() => {
              setSettingsOpen(true);
              closeAvatarMenu();
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            {t('设置')}
          </AnimatedButton>
          <div className="avatar-menu-sep" />
          <AnimatedButton
            type="button"
            className="avatar-menu-item"
            scale={1.02}
            onClick={() => {
              setHelpOpen(true);
              closeAvatarMenu();
            }}
          >
            <Icon icon="mdi:help-circle-outline" width="16" height="16" aria-hidden="true" />
            {t('帮助')}
          </AnimatedButton>
          <AnimatedButton
            type="button"
            className="avatar-menu-item"
            onClick={() => {
              setAboutOpen(true);
              closeAvatarMenu();
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            {t('关于')}
          </AnimatedButton>
        </motion.div>
      )}
    </AnimatePresence>

      {helpOpen ? (
        <LazyLoadBoundary label={t('帮助中心')}>
          <Suspense fallback={<LazyLoadFallback label={t('帮助中心')} />}>
            <HelpCenterDialog onClose={() => setHelpOpen(false)} />
          </Suspense>
        </LazyLoadBoundary>
      ) : null}

      <AboutDialog isOpen={aboutOpen} onClose={() => setAboutOpen(false)} />
    </>
  );
}

/* ============================================
   Logo / Project switcher menu
   ============================================ */
function LogoMenu() {
  const t = useT();
  const { projectLibraryOpen, setProjectLibraryOpen } = useAppStore(
    useShallow((state) => ({
      projectLibraryOpen: state.projectLibraryOpen,
      setProjectLibraryOpen: state.setProjectLibraryOpen,
    })),
  );

  useEffect(() => {
    if (!projectLibraryOpen) return;
    const projectId = useAppStore.getState().currentProjectId;
    if (!projectId) return;
    const timer = window.setTimeout(() => {
      const store = useAppStore.getState();
      if (!store.projectLibraryOpen || store.currentProjectId !== projectId) return;
      void store.captureCurrentProjectSnapshot({ persistSnapshot: true })
        .catch((error) => console.warn('[项目库] 更新预览失败:', error));
    }, 220);
    return () => window.clearTimeout(timer);
  }, [projectLibraryOpen]);

  return (
    <>
      <button
        type="button"
        className={`sidebar-btn-v3 sidebar-canvas-btn ${projectLibraryOpen ? 'active' : ''}`}
        data-tooltip={t('画布 / 项目')}
        aria-haspopup="dialog"
        aria-expanded={projectLibraryOpen}
        onClick={() => setProjectLibraryOpen(true)}
      >
        <svg className="ico-normal" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M3 4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zm0 14a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM18 3a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1zm-1 8a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1zm-6-1a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1zm-8 1a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zm8-8a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1zm-1 15a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1zm8-1a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1z" clipRule="evenodd" />
        </svg>
        <svg className="ico-hover" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <rect x="3" y="4" width="13" height="16" rx="2" />
          <path d="m19 8 3 4-3 4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M13 12h9" strokeLinecap="round" />
        </svg>
      </button>

      {createPortal(
        <ProjectLibraryModal
          isOpen={projectLibraryOpen}
          onClose={() => setProjectLibraryOpen(false)}
        />,
        document.body,
      )}
    </>
  );
}

/* ============================================
   Main Sidebar
   ============================================ */
export default function Sidebar() {
  const t = useT();
  const {
    openNodePicker,
    closeNodePicker,
    toggleAvatarMenu,
    nodePickerOpen,
    setAssetsPanelOpen,
    setCharacterLibraryOpen,
    setHistoryPanelOpen,
    unreadDramaAssetCount,
  } = useAppStore(
      useShallow((s) => ({
        openNodePicker: s.openNodePicker,
        closeNodePicker: s.closeNodePicker,
        toggleAvatarMenu: s.toggleAvatarMenu,
        nodePickerOpen: s.nodePickerOpen,
        setAssetsPanelOpen: s.setAssetsPanelOpen,
        setCharacterLibraryOpen: s.setCharacterLibraryOpen,
        setHistoryPanelOpen: s.setHistoryPanelOpen,
        unreadDramaAssetCount: countUnreadDramaAssets(s.dramaAssets),
      })),
    );
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleAddEnter = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openNodePicker();
  };
  const handleAddLeave = () => {
    closeTimer.current = setTimeout(closeNodePicker, 120);
  };
  const handlePickerEnter = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  };
  const handlePickerLeave = () => {
    closeNodePicker();
  };

  return (
    <aside data-tauri-drag-region className="sidebar-floating">
      {/* Add button — hover to open node picker */}
      <button
        id="btn-add-node"
        type="button"
        className={`sidebar-btn-v3 add-btn-v3 ${nodePickerOpen ? 'active' : ''}`}
        onMouseEnter={handleAddEnter}
        onMouseLeave={handleAddLeave}
        onClick={() => (nodePickerOpen ? closeNodePicker() : openNodePicker())}
        aria-label={t('添加节点')}
      >
        {/* Normal: plus */}
        <svg className="ico-normal" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        {/* Hover/active: cross */}
        <svg className="ico-hover" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </svg>
      </button>

      {/* Logo / Canvas home */}
      <div className="sidebar-logo-wrap">
        <LogoMenu />
      </div>

      {/* Assets */}
      <button
        type="button"
        className="sidebar-btn-v3"
        data-tooltip={unreadDramaAssetCount > 0 ? t('资产 · 新增短剧资产 ({count})', { count: unreadDramaAssetCount }) : t('资产')}
        onClick={() => setAssetsPanelOpen(true)}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"><path strokeDasharray="64" strokeDashoffset="64" d="M12 7h8c0.55 0 1 0.45 1 1v10c0 0.55 -0.45 1 -1 1h-16c-0.55 0 -1 -0.45 -1 -1v-11Z"><animate fill="freeze" attributeName="stroke-dashoffset" dur="0.6s" values="64;0"/></path><path d="M12 7h-9v0c0 0 0.45 0 1 0h6z" opacity="0"><animate fill="freeze" attributeName="d" begin="0.6s" dur="0.2s" values="M12 7h-9v0c0 0 0.45 0 1 0h6z;M12 7h-9v-1c0 -0.55 0.45 -1 1 -1h6z"/><set fill="freeze" attributeName="opacity" begin="0.6s" to="1"/></path></g></svg>
        {unreadDramaAssetCount > 0 ? (
          <span className="sidebar-badge">
            {unreadDramaAssetCount > 99 ? '99+' : unreadDramaAssetCount}
          </span>
        ) : null}
      </button>

      {/* Character library */}
      <button
        type="button"
        className="sidebar-btn-v3"
        data-tooltip={t('角色库')}
        aria-label={t('打开角色库')}
        onClick={() => setCharacterLibraryOpen(true)}
      >
        <Icon icon="lucide:contact-round" width="20" height="20" aria-hidden="true" />
      </button>

      {/* History */}
      <button type="button" className="sidebar-btn-v3" data-tooltip={t('输出历史')} onClick={() => setHistoryPanelOpen(true)}>
        <svg width="20" height="20" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5"><path d="M11.007 21H9.605c-3.585 0-5.377 0-6.491-1.135S2 16.903 2 13.25s0-5.48 1.114-6.615S6.02 5.5 9.605 5.5h3.803c3.585 0 5.378 0 6.492 1.135c.857.873 1.054 2.156 1.1 4.365"/><path d="m18.85 18.85l-1.35-.9V15.7M13 17.5a4.5 4.5 0 1 0 9 0a4.5 4.5 0 0 0-9 0m3-12l-.1-.31c-.494-1.54-.742-2.31-1.331-2.75C13.979 2 13.197 2 11.632 2h-.264c-1.565 0-2.348 0-2.937.44c-.59.44-.837 1.21-1.332 2.75L7 5.5"/></g></svg>
      </button>

      {/* AI Chat Assistant */}
      <button
        type="button"
        className="sidebar-btn-v3"
        data-tooltip={t('AI 助手')}
        aria-label={t('打开 AI 助手')}
        onClick={async () => {
          const store = useAppStore.getState();
          if (store.chatPanelDetached) {
            // 保留独立显示偏好：窗口被关闭后，再次点击仍打开独立窗口。
            try {
              await openDetachedChatWindow();
            } catch (error) {
              const detail = error instanceof Error ? error.message : '';
              store.showToast(`${t('打开独立窗口失败')}${detail ? `：${detail}` : ''}`, 'error');
            }
          } else {
            store.toggleChat();
          }
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
          <rect x="8.4" y="9.25" width="2" height="5.5" rx="1" fill="currentColor" />
          <rect x="13.6" y="9.25" width="2" height="5.5" rx="1" fill="currentColor" />
        </svg>
      </button>

      {/* Task Center */}
      {/* <button type="button" className="sidebar-btn-v3 task-center-btn">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M9 6h11" strokeLinecap="round" />
          <path d="M9 12h11" strokeLinecap="round" />
          <path d="M9 18h11" strokeLinecap="round" />
          <path d="M4 6l1 1 2-2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 12l1 1 2-2" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M4 18l1 1 2-2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="task-center-tooltip">
          <span>{t('任务')}</span>
          <span className="task-center-tooltip-beta">beta</span>
        </span>
      </button> */}

      {/* Separator */}
      <div className="sidebar-sep-v3" />

      {/* Settings / Avatar */}
      <div className="avatar-wrap">
        <button
          id="btn-user-gear"
          type="button"
          className="user-gear-plain"
          onClick={toggleAvatarMenu}
          data-tooltip={t('设置')}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
        </button>
        <AvatarMenu />
      </div>

      {/* Node Picker popup */}
      <NodePicker onEnter={handlePickerEnter} onLeave={handlePickerLeave} />
    </aside>
  );
}
