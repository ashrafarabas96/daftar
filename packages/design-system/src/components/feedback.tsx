'use client';
import type { CSSProperties, ReactNode } from 'react';
import { colors, radius, spacing, typography } from '../tokens';
import { Button } from './buttons';

export function Spinner({ label }: { label?: string }) {
  return (
    <div
      role="status"
      aria-label={label ?? 'loading'}
      style={{ display: 'inline-flex', alignItems: 'center', gap: spacing[2], fontFamily: typography.fontFamily.base }}
    >
      <span
        style={{
          width: '1.25rem',
          height: '1.25rem',
          borderRadius: radius.full,
          border: `2px solid ${colors.neutral[200]}`,
          borderTopColor: colors.brand.primary,
          animation: 'daftar-spin 0.8s linear infinite',
          display: 'inline-block',
        }}
      />
      <style>{'@keyframes daftar-spin { to { transform: rotate(360deg); } }'}</style>
      {label ? <span style={{ fontSize: typography.size.sm, color: colors.neutral[500] }}>{label}</span> : null}
    </div>
  );
}

export function Skeleton({ width = '100%', height = '1rem', style }: { width?: string; height?: string; style?: CSSProperties }) {
  return (
    <div
      aria-hidden
      style={{
        width,
        height,
        borderRadius: radius.sm,
        background: `linear-gradient(90deg, ${colors.neutral[100]} 25%, ${colors.neutral[200]} 50%, ${colors.neutral[100]} 75%)`,
        backgroundSize: '200% 100%',
        animation: 'daftar-shimmer 1.4s infinite',
        ...style,
      }}
    />
  );
}

function StateShell(props: { icon: string; title: string; description?: string; action?: ReactNode }) {
  return (
    <div style={{ textAlign: 'center', padding: `${spacing[10]} ${spacing[4]}`, fontFamily: typography.fontFamily.base }}>
      <div aria-hidden style={{ fontSize: '2.5rem', marginBottom: spacing[3] }}>
        {props.icon}
      </div>
      <h3 style={{ margin: `0 0 ${spacing[2]}`, fontSize: typography.size.lg, color: colors.neutral[900] }}>{props.title}</h3>
      {props.description ? <p style={{ margin: `0 0 ${spacing[4]}`, color: colors.neutral[500], fontSize: typography.size.sm }}>{props.description}</p> : null}
      {props.action}
    </div>
  );
}

export function EmptyState(props: { title: string; description?: string; actionLabel?: string; onAction?: () => void }) {
  return (
    <StateShell
      icon="◇"
      title={props.title}
      description={props.description}
      action={props.actionLabel ? <Button onClick={props.onAction}>{props.actionLabel}</Button> : undefined}
    />
  );
}

export function ErrorState(props: { title: string; description?: string; retryLabel?: string; onRetry?: () => void }) {
  return (
    <StateShell
      icon="⚠"
      title={props.title}
      description={props.description}
      action={
        props.retryLabel ? (
          <Button variant="secondary" onClick={props.onRetry}>
            {props.retryLabel}
          </Button>
        ) : undefined
      }
    />
  );
}

export function OfflineState(props: { title: string; description?: string }) {
  return <StateShell icon="⇵" title={props.title} description={props.description} />;
}

export function PermissionDeniedState(props: { title: string; description?: string }) {
  return <StateShell icon="🔒" title={props.title} description={props.description} />;
}

export function FeatureLockedState(props: { title: string; description?: string; upgradeLabel?: string; onUpgrade?: () => void }) {
  return (
    <StateShell
      icon="★"
      title={props.title}
      description={props.description}
      action={props.upgradeLabel ? <Button onClick={props.onUpgrade}>{props.upgradeLabel}</Button> : undefined}
    />
  );
}

export function PlanLimitState(props: { title: string; description?: string; upgradeLabel?: string; onUpgrade?: () => void }) {
  return (
    <StateShell
      icon="▲"
      title={props.title}
      description={props.description}
      action={
        props.upgradeLabel ? (
          <Button variant="secondary" onClick={props.onUpgrade}>
            {props.upgradeLabel}
          </Button>
        ) : undefined
      }
    />
  );
}
