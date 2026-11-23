/**
 * freeDistributionNoticeDialog — 回归测试：黄瓜使用说明。
 */
import { isValidElement, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/i18n', () => ({
  useT: () => (text: string) => text,
}));

import FreeDistributionNoticeDialog from '../../src/components/FreeDistributionNoticeDialog';
import ModalOverlay from '../../src/components/shared/ModalOverlay';

function elements(root: unknown): Array<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(root)) return root.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(root)) return [];
  return [root, ...elements(root.props.children)];
}

function textContent(root: unknown): string {
  if (typeof root === 'string' || typeof root === 'number') return String(root);
  if (Array.isArray(root)) return root.map(textContent).join(' ');
  if (!isValidElement<Record<string, unknown>>(root)) return '';
  return textContent(root.props.children);
}

describe('黄瓜使用说明', () => {
  it('明确账号、计费与本地备份说明，并且只能通过确认关闭', () => {
    const onAcknowledge = vi.fn();
    const dialog = FreeDistributionNoticeDialog({ onAcknowledge });

    expect(dialog.type).toBe(ModalOverlay);
    expect(dialog.props).toMatchObject({
      closeOnBackdrop: false,
      onClose: onAcknowledge,
      ariaLabel: '黄瓜 AI 使用说明',
    });

    const content = textContent(dialog);
    expect(content).toContain('欢迎使用黄瓜 AI');
    expect(content).not.toContain('XiaoA250908');
    expect(content).toContain('黄瓜 AI 账号页面');
    expect(content).toContain('项目与资源保存在本机');

    const confirmButton = elements(dialog).find((element) => (
      element.type === 'button' && textContent(element).includes('我知道了，继续使用')
    ));
    expect(confirmButton?.props).toMatchObject({ autoFocus: true, onClick: onAcknowledge });
    (confirmButton?.props.onClick as () => void)();
    expect(onAcknowledge).toHaveBeenCalledOnce();
  });
});
