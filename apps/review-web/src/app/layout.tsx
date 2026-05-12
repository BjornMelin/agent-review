import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Review Room',
    template: '%s | Review Room',
  },
  description:
    'Operational review run history, live status, findings, artifacts, and publication controls for Review Agent Platform.',
  applicationName: 'Review Room',
  robots: {
    index: false,
    follow: false,
  },
  openGraph: {
    title: 'Review Room',
    description:
      'Review Agent Platform operations surface for hosted review runs.',
    type: 'website',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  colorScheme: 'light dark',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): React.ReactNode {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
