'use client';
import { AlertTriangle } from 'lucide-react';
import { Logo } from '@/components/brand';

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center" role="alert">
      <Logo />
      <div className="mt-6 flex size-12 items-center justify-center rounded-full bg-bad-soft text-bad"><AlertTriangle className="size-6" /></div>
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="max-w-sm text-[13px] text-ink-2">An unexpected error occurred. Your data is safe. Try again, or reload the page.</p>
      <button onClick={reset} className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-white hover:bg-accent-hover">Try again</button>
    </div>
  );
}
