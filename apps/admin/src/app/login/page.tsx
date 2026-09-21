'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, PasswordField, TextField, colors, spacing, typography } from '@daftar/design-system';
import { setAccessToken } from '@/lib/client';

export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.status === 429 ? 'Too many attempts — wait and retry' : 'Invalid credentials or insufficient platform role');
      return;
    }
    const data = (await res.json()) as { accessToken: string };
    setAccessToken(data.accessToken);
    router.push('/');
  }

  return (
    <main style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: spacing[4] }}>
      <Card style={{ width: '100%', maxWidth: '24rem' }}>
        <h1 style={{ fontFamily: typography.fontFamily.base, color: colors.neutral[900] }}>Platform sign in</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: spacing[4] }}
        >
          <TextField label="Email" type="email" required value={email} onChange={setEmail} autoComplete="email" />
          <PasswordField label="Password" required value={password} onChange={setPassword} />
          {error ? <p role="alert" style={{ color: colors.semantic.danger, margin: 0 }}>{error}</p> : null}
          <Button type="submit" loading={busy} fullWidth>Sign in</Button>
        </form>
      </Card>
    </main>
  );
}
