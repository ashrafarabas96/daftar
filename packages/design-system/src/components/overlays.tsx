'use client';
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { colors, elevation, radius, spacing, typography, zIndex } from '../tokens';
import { Button } from './buttons';

const backdrop: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.5)', zIndex: zIndex.overlay,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: spacing[4],
};

const panel: CSSProperties = {
  background: colors.neutral[0], borderRadius: radius.xl, boxShadow: elevation.lg,
  padding: spacing[6], maxWidth: '32rem', width: '100%', fontFamily: typography.fontFamily.base,
};

export interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

export function Dialog({ open, title, onClose, children, footer }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div style={backdrop} onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={panel}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: `0 0 ${spacing[4]}`, fontSize: typography.size.xl, color: colors.neutral[900] }}>{title}</h2>
        <div>{children}</div>
        {footer ? <div style={{ display: 'flex', gap: spacing[2], justifyContent: 'flex-end', marginTop: spacing[5] }}>{footer}</div> : null}
      </div>
    </div>
  );
}

export interface ConfirmationDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmationDialog(props: ConfirmationDialogProps) {
  return (
    <Dialog
      open={props.open}
      title={props.title}
      onClose={props.onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={props.onCancel}>{props.cancelLabel}</Button>
          <Button variant={props.danger ? 'danger' : 'primary'} loading={props.loading} onClick={props.onConfirm}>{props.confirmLabel}</Button>
        </>
      }
    >
      <p style={{ margin: 0, color: colors.neutral[700], fontSize: typography.size.md }}>{props.message}</p>
    </Dialog>
  );
}

export interface DrawerProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function Drawer({ open, title, onClose, children }: DrawerProps) {
  if (!open) return null;
  return (
    <div style={backdrop} onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed', top: 0, bottom: 0, insetInlineEnd: 0, width: 'min(28rem, 92vw)',
          background: colors.neutral[0], boxShadow: elevation.lg, padding: spacing[5],
          overflowY: 'auto', fontFamily: typography.fontFamily.base, zIndex: zIndex.modal,
        }}
      >
        <h2 style={{ margin: `0 0 ${spacing[4]}`, fontSize: typography.size.xl }}>{title}</h2>
        {children}
      </aside>
    </div>
  );
}

export function BottomSheet({ open, title, onClose, children }: DrawerProps) {
  if (!open) return null;
  return (
    <div style={{ ...backdrop, alignItems: 'flex-end', padding: 0 }} onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxHeight: '85vh', overflowY: 'auto',
          background: colors.neutral[0], borderRadius: `${radius.xl} ${radius.xl} 0 0`,
          padding: spacing[5], fontFamily: typography.fontFamily.base, zIndex: zIndex.modal,
        }}
      >
        <div style={{ width: '2.5rem', height: '0.25rem', borderRadius: radius.full, background: colors.neutral[300], margin: `0 auto ${spacing[3]}` }} />
        <h2 style={{ margin: `0 0 ${spacing[4]}`, fontSize: typography.size.lg }}>{title}</h2>
        {children}
      </section>
    </div>
  );
}

export interface Toast {
  id: string;
  message: string;
  tone?: 'success' | 'danger' | 'info';
}

export function ToastRegion({ toasts }: { toasts: Toast[] }) {
  const bg = { success: colors.semantic.success, danger: colors.semantic.danger, info: colors.semantic.info };
  return (
    <div aria-live="polite" style={{ position: 'fixed', bottom: spacing[4], insetInlineEnd: spacing[4], zIndex: zIndex.toast, display: 'flex', flexDirection: 'column', gap: spacing[2] }}>
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          style={{
            background: bg[t.tone ?? 'info'], color: colors.neutral[0], padding: `${spacing[3]} ${spacing[4]}`,
            borderRadius: radius.md, boxShadow: elevation.md, fontFamily: typography.fontFamily.base,
            fontSize: typography.size.sm,
          }}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }} title={label}>
      {children}
    </span>
  );
}
