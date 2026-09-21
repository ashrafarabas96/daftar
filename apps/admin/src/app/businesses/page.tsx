'use client';
import { useEffect, useState } from 'react';
import { Badge, Table, typography } from '@daftar/design-system';
import { apiFetch } from '@/lib/client';
import { Shell } from '../Shell';

interface Business {
  id: string;
  name: string;
  store_slug: string;
  base_currency: string;
  status: string;
  created_at: string;
}

export default function BusinessesPage() {
  const [items, setItems] = useState<Business[]>([]);
  useEffect(() => {
    void (async () => {
      const res = await apiFetch<{ items: Business[] }>('/api/proxy/admin/businesses');
      setItems(res.items);
    })();
  }, []);
  return (
    <Shell active="businesses">
      <h1 style={{ fontFamily: typography.fontFamily.base }}>Businesses</h1>
      <Table
        rows={items}
        columns={[
          { key: 'name', header: 'Name', render: (b) => b.name },
          { key: 'slug', header: 'Slug', render: (b) => <code>{b.store_slug}</code> },
          { key: 'currency', header: 'Currency', render: (b) => b.base_currency },
          { key: 'status', header: 'Status', render: (b) => <Badge tone={b.status === 'active' ? 'success' : 'neutral'}>{b.status}</Badge> },
          { key: 'created', header: 'Created', render: (b) => new Date(b.created_at).toLocaleDateString() },
        ]}
      />
    </Shell>
  );
}
