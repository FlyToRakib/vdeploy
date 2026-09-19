import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import type { ReactNode } from 'react';
import { ThemeProvider } from '@/components/theme-provider';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'VDeploy', template: '%s · VDeploy' },
  description: 'Deploy, run and keep your apps alive on servers you own.',
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0d12' },
  ],
};

// eslint-disable-next-line no-restricted-syntax -- Next.js requires a default export
export default async function RootLayout({ children }: { children: ReactNode }) {
  // The per-request CSP nonce (proxy.ts) lets the theme script run before first paint.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${GeistSans.variable} ${GeistMono.variable}`}
    >
      <body className="font-sans antialiased">
        <ThemeProvider {...(nonce ? { nonce } : {})}>{children}</ThemeProvider>
      </body>
    </html>
  );
}
