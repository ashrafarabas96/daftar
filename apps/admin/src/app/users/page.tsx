'use client';
import { useEffect, useState } from 'react';
import type { AdminUserDto } from '@daftar/shared-contracts';
import { Badge, Table, typography } from '@daftar/design-system';
import { listUsers } from '@/lib/admin-api';
import { useT } from '@/lib/i18n';
import { Shell } from '../Shell';

export default function UsersPage() {
  const t = useT();
  const [items, setItems] = useState<AdminUserDto[]>([]);
  useEffect(() => {
    void listUsers().then((r) => setItems(r.items));
  }, []);
  return (
    <Shell active="users">
      <h1 style={{ fontFamily: typography.fontFamily.base }}>{t('users.title')}</h1>
      <Table
        rows={items}
        columns={[
          { key: 'email', header: t('common.col.email'), render: (u) => u.email },
          { key: 'name', header: t('common.col.name'), render: (u) => u.displayName },
          { key: 'role', header: t('users.col.platformRole'), render: (u) => (u.platformRole ? <Badge tone="brand">{u.platformRole}</Badge> : '—') },
          { key: 'created', header: t('common.col.created'), render: (u) => new Date(u.createdAt).toLocaleDateString() },
        ]}
      />
    </Shell>
  );
}
