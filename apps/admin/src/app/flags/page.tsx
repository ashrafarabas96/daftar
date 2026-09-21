'use client';
import { useEffect, useState } from 'react';
import { Switch, Table, typography } from '@daftar/design-system';
import { apiFetch } from '@/lib/client';
import { Shell } from '../Shell';

interface Flag {
  key: string;
  description: string;
  enabled: boolean;
}

export default function FlagsPage() {
  const [items, setItems] = useState<Flag[]>([]);

  async function load() {
    const res = await apiFetch<{ items: Flag[] }>('/api/proxy/admin/feature-flags');
    setItems(res.items);
  }

  useEffect(() => {
    void load();
  }, []);

  async function toggle(key: string, enabled: boolean) {
    await apiFetch('/api/proxy/admin/feature-flags', { method: 'POST', body: JSON.stringify({ key, enabled }) });
    await load();
  }

  return (
    <Shell active="flags">
      <h1 style={{ fontFamily: typography.fontFamily.base }}>Feature flags</h1>
      <Table
        rows={items.map((f) => ({ ...f, id: f.key }))}
        columns={[
          { key: 'key', header: 'Flag', render: (f) => <code>{f.key}</code> },
          { key: 'description', header: 'Description', render: (f) => f.description },
          { key: 'enabled', header: 'Enabled', render: (f) => <Switch label={f.key} checked={f.enabled} onChange={(v) => void toggle(f.key, v)} /> },
        ]}
      />
    </Shell>
  );
}
