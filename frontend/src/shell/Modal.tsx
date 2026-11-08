import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../lib/cx';
import { IconClose } from './icons';

interface ModalProps {
  open: boolean;
  title: string;
  subtitle?: string;
  width?: number;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
}

/** 轻量弹窗基元：Esc / 遮罩点击关闭。后续任务的抽屉（Drawer）也复用此层约定。 */
export function Modal({ open, title, subtitle, width = 520, onClose, children, footer }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ width }}>
        <header className="modal-head">
          <div className="modal-head-text">
            <h2 className="modal-title">{title}</h2>
            {subtitle ? <p className="modal-sub">{subtitle}</p> : null}
          </div>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
            <IconClose />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmConfig {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
}

interface ConfirmDialogProps {
  open: boolean;
  config: ConfirmConfig | null;
  busy?: boolean;
  onClose(): void;
  onConfirm(): void;
}

/** 通用确认弹窗（暂停 / 归档等破坏性较小的状态迁移）。 */
export function ConfirmDialog({ open, config, busy = false, onClose, onConfirm }: ConfirmDialogProps) {
  return (
    <Modal
      open={open && config !== null}
      title={config?.title ?? ''}
      width={440}
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <button type="button" className="btn btn-default" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className={cx('btn', config?.danger ? 'btn-danger' : 'btn-primary')}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? '处理中…' : (config?.confirmLabel ?? '确认')}
          </button>
        </>
      }
    >
      <p className="confirm-message">{config?.message}</p>
    </Modal>
  );
}
