'use client';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { colors, elevation, radius, spacing, typography, zIndex } from '../tokens';

export function Card(props: { children: ReactNode; padded?: boolean; style?: CSSProperties }) {
  return (
    <div
      style={{
        background: colors.neutral[0],
        border: `1px solid ${colors.neutral[200]}`,
        borderRadius: radius.lg,
        boxShadow: elevation.sm,
        padding: props.padded === false ? 0 : spacing[4],
        ...props.style,
      }}
    >
      {props.children}
    </div>
  );
}

type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand';

const tones: Record<BadgeTone, CSSProperties> = {
  neutral: { background: colors.neutral[100], color: colors.neutral[700] },
  success: { background: colors.semantic.successSoft, color: colors.semantic.success },
  warning: { background: colors.semantic.warningSoft, color: colors.semantic.warning },
  danger: { background: colors.semantic.dangerSoft, color: colors.semantic.danger },
  info: { background: colors.semantic.infoSoft, color: colors.semantic.info },
  brand: { background: colors.brand.primarySoft, color: colors.brand.primary },
};

export function Badge(props: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', padding: `0 ${spacing[2]}`,
        minHeight: '1.375rem', borderRadius: radius.full,
        fontSize: typography.size.xs, fontWeight: typography.weight.semibold,
        fontFamily: typography.fontFamily.base, ...tones[props.tone ?? 'neutral'],
      }}
    >
      {props.children}
    </span>
  );
}

export function Tabs(props: { tabs: { key: string; label: string }[]; active: string; onChange: (key: string) => void }) {
  return (
    <div role="tablist" style={{ display: 'flex', gap: spacing[1], borderBottom: `1px solid ${colors.neutral[200]}`, fontFamily: typography.fontFamily.base }}>
      {props.tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={props.active === t.key}
          onClick={() => props.onChange(t.key)}
          style={{
            padding: `${spacing[2]} ${spacing[4]}`, background: 'none', border: 'none', cursor: 'pointer',
            fontSize: typography.size.md, fontWeight: props.active === t.key ? typography.weight.semibold : typography.weight.regular,
            color: props.active === t.key ? colors.brand.primary : colors.neutral[500],
            borderBottom: `2px solid ${props.active === t.key ? colors.brand.primary : 'transparent'}`,
            minHeight: '2.75rem',
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  align?: 'start' | 'end' | 'center';
}

export function Table<T extends { id?: string }>(props: { columns: Column<T>[]; rows: T[]; empty?: ReactNode }) {
  const cell = (align?: 'start' | 'end' | 'center'): CSSProperties => ({
    padding: `${spacing[2]} ${spacing[3]}`, textAlign: align === 'end' ? 'end' : align === 'center' ? 'center' : 'start',
    borderBottom: `1px solid ${colors.neutral[100]}`, fontSize: typography.size.sm,
  });
  if (props.rows.length === 0 && props.empty) return <>{props.empty}</>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: typography.fontFamily.base }}>
        <thead>
          <tr>
            {props.columns.map((c) => (
              <th key={c.key} style={{ ...cell(c.align), color: colors.neutral[500], fontWeight: typography.weight.medium }}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r, i) => (
            <tr key={r.id ?? i}>
              {props.columns.map((c) => (
                <td key={c.key} style={{ ...cell(c.align), color: colors.neutral[800] }}>{c.render(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function List(props: { items: { key: string; primary: ReactNode; secondary?: ReactNode; trailing?: ReactNode; onClick?: () => void }[] }) {
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontFamily: typography.fontFamily.base }}>
      {props.items.map((it) => (
        <li
          key={it.key}
          onClick={it.onClick}
          style={{
            display: 'flex', alignItems: 'center', gap: spacing[3], padding: `${spacing[3]} ${spacing[2]}`,
            borderBottom: `1px solid ${colors.neutral[100]}`, cursor: it.onClick ? 'pointer' : undefined,
            minHeight: '2.75rem',
          }}
        >
          <span style={{ flex: 1 }}>
            <span style={{ display: 'block', fontSize: typography.size.md, color: colors.neutral[900] }}>{it.primary}</span>
            {it.secondary ? <span style={{ display: 'block', fontSize: typography.size.sm, color: colors.neutral[500] }}>{it.secondary}</span> : null}
          </span>
          {it.trailing}
        </li>
      ))}
    </ul>
  );
}

export function Pagination(props: { page: number; pageCount: number; onChange: (page: number) => void }) {
  return (
    <nav aria-label="pagination" style={{ display: 'flex', gap: spacing[2], justifyContent: 'center', fontFamily: typography.fontFamily.base }}>
      {Array.from({ length: props.pageCount }, (_, i) => i + 1).map((p) => (
        <button
          key={p}
          aria-current={p === props.page ? 'page' : undefined}
          onClick={() => props.onChange(p)}
          style={{
            minWidth: '2.75rem', minHeight: '2.75rem', borderRadius: radius.md, cursor: 'pointer',
            border: `1px solid ${p === props.page ? colors.brand.primary : colors.neutral[300]}`,
            background: p === props.page ? colors.brand.primarySoft : colors.neutral[0],
            color: p === props.page ? colors.brand.primary : colors.neutral[700],
          }}
        >
          {p}
        </button>
      ))}
    </nav>
  );
}

export function Breadcrumb(props: { items: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="breadcrumb" style={{ fontFamily: typography.fontFamily.base, fontSize: typography.size.sm }}>
      <ol style={{ display: 'flex', gap: spacing[2], listStyle: 'none', margin: 0, padding: 0 }}>
        {props.items.map((it, i) => (
          <li key={i} style={{ display: 'flex', gap: spacing[2], color: colors.neutral[500] }}>
            {i > 0 ? <span aria-hidden>/</span> : null}
            {it.href ? <a href={it.href} style={{ color: colors.brand.primary, textDecoration: 'none' }}>{it.label}</a> : <span aria-current="page">{it.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function Dropdown(props: { trigger: ReactNode; items: { key: string; label: string; danger?: boolean; onSelect: () => void }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative', display: 'inline-block', fontFamily: typography.fontFamily.base }}>
      <span onClick={() => setOpen((o) => !o)}>{props.trigger}</span>
      {open ? (
        <div
          role="menu"
          style={{
            position: 'absolute', insetInlineEnd: 0, top: '100%', zIndex: zIndex.dropdown,
            background: colors.neutral[0], border: `1px solid ${colors.neutral[200]}`, borderRadius: radius.md,
            boxShadow: elevation.md, minWidth: '12rem', padding: spacing[1],
          }}
        >
          {props.items.map((it) => (
            <button
              key={it.key}
              role="menuitem"
              onClick={() => { setOpen(false); it.onSelect(); }}
              style={{
                display: 'block', width: '100%', textAlign: 'start', padding: `${spacing[2]} ${spacing[3]}`,
                background: 'none', border: 'none', cursor: 'pointer', borderRadius: radius.sm,
                color: it.danger ? colors.semantic.danger : colors.neutral[800], fontSize: typography.size.sm,
                minHeight: '2.75rem',
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
