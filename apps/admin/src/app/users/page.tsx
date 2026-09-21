'use client';
import { useEffect, useState } from 'react';
import type { AdminUserDto } from '@daftar/shared-contracts';
import { Badge, Table, typography } from '@daftar/design-system';
import { listUsers } from '@/lib/admin-api';
import { Shell } from '../Shell';

export default function UsersPage() {
  const [items, setItems] = useState<AdminUserDto[]>([]);
  useEffect(() => {
    void listUsers().then((r) => setItems(r.items));
  }, []);
  return (
    <Shell active="users">
      <h1 style={{ fontFamily: typography.fontFamily.base }}>Users</h1>
      <Table
        rows={items}
        columns={[
          { key: 'email', header: 'Email', render: (u) => u.email },
          { key: 'name', header: 'Name', render: (u) => u.displayName },
          { key: 'role', header: 'Platform role', render: (u) => (u.platformRole ? <Badge tone="brand">{u.platformRole}</Badge> : '—') },
          { key: 'created', header: 'Created', render: (u) => new Date(u.createdAt).toLocaleDateString() },
        ]}
      />
    </Shell>
  );
}
