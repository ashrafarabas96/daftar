'use client';
import { useEffect, useState } from 'react';
import type { FeatureFlagDto } from '@daftar/shared-contracts';
import { Button, Switch, Table, TextField, spacing, typography } from '@daftar/design-system';
import { listFeatureFlags, setFeatureFlag } from '@/lib/admin-api';
import { Shell } from '../Shell';

export default function FlagsPage() {
  const [items, setItems] = useState<FeatureFlagDto[]>([]);
  const [newKey, setNewKey] = useState('');
  const [newDescription, setNewDescription] = useState('');

  async function load() {
    setItems((await listFeatureFlags()).items);
  }
  useEffect(() => {
    void load();
  }, []);

  async function toggle(key: string, enabled: boolean) {
    await setFeatureFlag(key, enabled);
    await load();
  }

  async function add() {
    await setFeatureFlag(newKey.trim(), false, newDescription.trim());
    setNewKey('');
    setNewDescription('');
    await load();
  }

  return (
    <Shell active="flags">
      <h1 style={{ fontFamily: typography.fontFamily.base }}>Feature flags</h1>
      <p style={{ fontFamily: typography.fontFamily.base, fontSize: typography.size.sm }}>
        Technical enablement only — separate from commercial entitlements (plans/overrides).
      </p>
      <Table
        rows={items.map((f) => ({ ...f, id: f.key }))}
        columns={[
          { key: 'key', header: 'Flag', render: (f) => <code>{f.key}</code> },
          { key: 'description', header: 'Description', render: (f) => f.description },
          { key: 'updated', header: 'Updated', render: (f) => new Date(f.updatedAt).toLocaleString() },
          { key: 'enabled', header: 'Enabled', render: (f) => <Switch label={f.key} checked={f.enabled} onChange={(v) => void toggle(f.key, v)} /> },
        ]}
      />
      <div style={{ display: 'flex', gap: spacing[2], alignItems: 'flex-end', marginTop: spacing[4], maxWidth: '40rem' }}>
        <TextField label="New flag key" value={newKey} onChange={setNewKey} />
        <TextField label="Description" value={newDescription} onChange={setNewDescription} />
        <Button variant="secondary" disabled={!/^[A-Z][A-Z0-9_]{1,63}$/.test(newKey.trim())} onClick={() => void add()}>
          Add (disabled)
        </Button>
      </div>
    </Shell>
  );
}
