import type { ReactNode } from 'react';
import { DaftarProvider } from '@daftar/design-system';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" dir="ltr">
      <body style={{ margin: 0, background: '#0F172A' }}>
        <DaftarProvider locale="en">{children}</DaftarProvider>
      </body>
    </html>
  );
}
