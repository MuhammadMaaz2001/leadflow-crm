import { cn } from '@/lib/utils';

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-7', className)} aria-hidden>
      <rect width="32" height="32" rx="8" fill="#5558e3" />
      <path d="M9 22V10h3.2v9H20v3H9Z" fill="#fff" opacity=".95" />
      <circle cx="22" cy="11" r="2.4" fill="#fff" />
    </svg>
  );
}
export function Logo({ className, compact }: { className?: string; compact?: boolean }) {
  return <span className={cn('inline-flex items-center gap-2', className)}><LogoMark />{!compact && <span className="text-[15px] font-semibold tracking-tight">LeadFlow</span>}</span>;
}
