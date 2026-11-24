import Link from 'next/link';
import { Compass } from 'lucide-react';
import { Logo } from '@/components/brand';

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <Logo />
      <div className="mt-6 flex size-12 items-center justify-center rounded-full bg-subtle text-ink-3"><Compass className="size-6" /></div>
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p className="max-w-sm text-[13px] text-ink-2">The page you are looking for doesn&apos;t exist or has moved.</p>
      <Link href="/dashboard" className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-white hover:bg-accent-hover">Go to dashboard</Link>
    </div>
  );
}
