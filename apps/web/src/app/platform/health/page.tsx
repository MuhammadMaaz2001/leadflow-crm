'use client';
import { CheckCircle2, Cpu, Database, HardDrive, Layers, XCircle } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Badge, Card, CardHeader, KeyValue, PageHeader, Skeleton } from '@/components/ui/data';

interface H { status: string; checks: { database: { ok: boolean; latencyMs: number }; redis: { ok: boolean }; queue: { ok: boolean; counts: Record<string, number> | null } }; system: { node: string; uptimeSeconds: number; memoryMb: number; loadAvg: number[]; env: string; appliedMigrations: number }; jobsMode: string }
const Check = ({ ok, label, detail, icon }: { ok: boolean; label: string; detail?: string; icon: React.ReactNode }) => <Card className="flex items-center gap-3 p-4"><span className={`flex size-10 items-center justify-center rounded-lg [&>svg]:size-5 ${ok ? 'bg-ok-soft text-ok' : 'bg-bad-soft text-bad'}`}>{icon}</span><div className="flex-1"><p className="text-[13px] font-semibold">{label}</p><p className="text-xs text-ink-3">{detail}</p></div>{ok ? <CheckCircle2 className="size-5 text-ok" /> : <XCircle className="size-5 text-bad" />}</Card>;

export default function HealthPage() {
  const q = useQuery({ queryKey: ['platform', 'health'], queryFn: () => api.get<H>('/platform/health', undefined, { tenant: false }), refetchInterval: 10_000 });
  const h = q.data;
  return (
    <>
      <PageHeader title="System health" description="Live status of the API, database and background job queue." actions={h && <Badge tone={h.status === 'healthy' ? 'ok' : h.status === 'degraded' ? 'warn' : 'bad'}>{h.status}</Badge>} />
      {!h ? <Skeleton className="h-60" /> : (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            <Check ok={h.checks.database.ok} label="PostgreSQL" detail={`${h.checks.database.latencyMs} ms round trip`} icon={<Database />} />
            <Check ok={h.checks.redis.ok} label="Redis" detail="Queue and scheduler store" icon={<HardDrive />} />
            <Check ok={h.checks.queue.ok} label="Job queue (BullMQ)" detail={h.checks.queue.counts ? Object.entries(h.checks.queue.counts).map(([k, v]) => `${k} ${v}`).join(' · ') : 'unavailable'} icon={<Layers />} />
          </div>
          <Card className="mt-4"><CardHeader title="Runtime" /><dl className="divide-y divide-line px-4 pb-3"><KeyValue label="Job mode">{h.jobsMode}</KeyValue><KeyValue label="Environment">{h.system.env}</KeyValue><KeyValue label="Node">{h.system.node}</KeyValue><KeyValue label="Uptime">{Math.floor(h.system.uptimeSeconds / 3600)}h {Math.floor((h.system.uptimeSeconds % 3600) / 60)}m</KeyValue><KeyValue label="Memory (RSS)">{h.system.memoryMb} MB</KeyValue><KeyValue label="Load average">{h.system.loadAvg.join(' · ')}</KeyValue><KeyValue label="Applied migrations">{h.system.appliedMigrations}</KeyValue></dl></Card>
          <p className="mt-3 flex items-center gap-1.5 text-xs text-ink-3"><Cpu className="size-3.5" />Refreshes every 10 seconds.</p>
        </>
      )}
    </>
  );
}
