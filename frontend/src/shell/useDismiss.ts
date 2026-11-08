import { useEffect } from 'react';

/**
 * 菜单/弹层的关闭辅助：点击根元素之外、或按 Esc 时触发 onClose。
 * 根元素需要标记 data-dismiss-root（内部点击不触发关闭）。
 */
export function useDismiss(open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-dismiss-root]')) {
        return;
      }
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);
}
