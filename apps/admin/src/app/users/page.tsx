'use client';
import { useEffect, useState } from 'react';
import { Badge, Table, typography } from '@daftar/design-system';
import { apiFetch } from '@/lib/client';
import { Shell } from '../Shell';

interface User {
  id: string;
  email: string;
  display_name: string;
  platform_role: string | null;
  created_at: string;
}

export default function UsersPage() {
  const [items, setItems] = useState<User[]>([]);
  useEffect(() => {
    void (async () => {
      const res = await apiFetch<{ items: User[] }>('/api/proxy/admin/users');
      setItems(res.items);
    })();
  }, []);
  return (
    <Shell active="users">
      <h1 style={{ fontFamily: typography.fontFamily.base }}>Users</h1>
      <Table
        rows={items}
        columns={[
          { key: 'email', header: 'Email', render: (u) => u.email },
          { key: 'name', header: 'Name', render: (u) => u.display_name },
          { key: 'role', header: 'Platform role', render: (u) => (u.platform_role ? <Badge tone="brand">{u.platform_role}</Badge> : '—') },
          { key: 'created', header: 'Created', render: (u) => new Date(u.created_at).toLocaleDateString() },
        ]}
      />
    </Shell>
  );
}
