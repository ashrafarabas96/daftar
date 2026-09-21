'use client';
import { useEffect, useState } from 'react';
import { Badge, colors, spacing, typography } from '@daftar/design-system';
import { Shell } from '../Shell';

interface Health {
  live: boolean | null;
  ready: boolean | null;
}

export default function OperationsPage() {
  const [health, setHealth] = useState<Health>({ live: null, ready: null });

  useEffect(() => {
    const ping = async () => {
      const [live, ready] = await Promise.all([
        fetch('/api/proxy/health/live').then((r) => r.ok).catch(() => false),
        fetch('/api/proxy/health/ready').then((r) => r.ok).catch(() => false),
      ]);
      setHealth({ live, ready });
    };
    void ping();
    const timer = setInterval(() => void ping(), 15_000);
    return () => clearInterval(timer);
  }, []);

  const badge = (v: boolean | null) =>
    v === null ? <Badge tone="neutral">unknown</Badge> : v ? <Badge tone="success">healthy</Badge> : <Badge tone="danger">down</Badge>;

  return (
    <Shell active="operations">
      <h1 style={{ fontFamily: typography.fontFamily.base }}>Operations</h1>
      <div style={{ display: 'flex', gap: spacing[6], fontFamily: typography.fontFamily.base, color: colors.neutral[800] }}>
        <p>Liveness: {badge(health.live)}</p>
        <p>Readiness: {badge(health.ready)}</p>
      </div>
      <p style={{ color: colors.neutral[500], fontSize: typography.size.sm }}>Auto-refreshes every 15s.</p>
    </Shell>
  );
}
