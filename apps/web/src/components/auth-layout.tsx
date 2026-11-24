import Link from 'next/link';
import { CalendarCheck, GitBranch, ShieldCheck, Target } from 'lucide-react';
import { Logo } from './brand';

export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="flex flex-col px-5 py-8 sm:px-10">
        <Link href="/" aria-label="LeadFlow"><Logo /></Link>
        <div className="mx-auto flex w-full max-w-[380px] flex-1 flex-col justify-center py-10">
          <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="mt-1.5 text-[13px] leading-5 text-ink-2">{subtitle}</p>}
          <div className="mt-6">{children}</div>
          {footer && <div className="mt-6 text-center text-[13px] text-ink-2">{footer}</div>}
        </div>
      </div>
      <aside className="relative hidden overflow-hidden bg-[#14142b] p-12 text-white lg:flex lg:flex-col lg:justify-between" aria-hidden>
        <div className="absolute inset-0 opacity-60" style={{ backgroundImage: 'radial-gradient(circle at 20% 10%, rgba(85,88,227,.45), transparent 45%), radial-gradient(circle at 90% 90%, rgba(56,189,248,.18), transparent 40%)' }} />
        <div className="relative max-w-md">
          <p className="text-3xl font-semibold leading-tight tracking-tight">Every lead owned.<br />Every follow-up scheduled.<br />Nothing falls through.</p>
          <ul className="mt-10 space-y-5 text-[13px] text-white/80">
            {[[<Target key="a" />, 'One place for every lead, source and conversation'], [<CalendarCheck key="b" />, 'Follow-ups with due dates, outcomes and reminders'], [<GitBranch key="c" />, 'A pipeline your whole team can see and trust'], [<ShieldCheck key="d" />, 'Private workspaces with role-based access']].map(([icon, text], i) => (
              <li key={i} className="flex items-center gap-3"><span className="flex size-8 items-center justify-center rounded-lg bg-white/10 [&>svg]:size-4">{icon}</span>{text}</li>
            ))}
          </ul>
        </div>
        <div className="relative rounded-xl border border-white/10 bg-white/5 p-4 text-[12px] text-white/70 backdrop-blur">
          <div className="mb-2 flex items-center justify-between"><span className="font-medium text-white">This week</span><span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-emerald-300">+18% conversion</span></div>
          <div className="flex h-14 items-end gap-1.5">{[30, 44, 36, 58, 52, 70, 64, 82, 76, 94].map((h, i) => <span key={i} className="flex-1 rounded-sm bg-white/25" style={{ height: `${h}%` }} />)}</div>
        </div>
      </aside>
    </div>
  );
}
