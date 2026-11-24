import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from '@/lib/session';

export const metadata: Metadata = {
  title: { default: 'LeadFlow CRM', template: '%s · LeadFlow' },
  description: 'Multi-tenant lead management CRM: leads, pipeline, follow-ups, tasks, reports and team performance.',
  icons: { icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%235558e3'/><path d='M9 22V10h3.2v9H20v3H9Z' fill='white'/><circle cx='22' cy='11' r='2.4' fill='white'/></svg>" },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#f7f7f8' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body><Providers>{children}</Providers></body>
    </html>
  );
}
