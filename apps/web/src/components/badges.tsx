import { Mail, MessageCircle, Phone, StickyNote, Users, Video, CircleEllipsis } from 'lucide-react';
import { Badge } from '@/components/ui/data';
import { STATUS_META } from '@/lib/lead-utils';

export function StatusBadge({ status }: { status: string }) {
  const m = STATUS_META[status] ?? { label: status, tone: 'neutral' as const };
  return <Badge tone={m.tone}>{m.label}</Badge>;
}
export function PriorityDot({ priority }: { priority?: { name: string; color: string } | null }) {
  if (!priority) return <span className="text-ink-3">—</span>;
  return <span className="inline-flex items-center gap-1.5 text-[13px]"><span className="size-2 rounded-full" style={{ background: priority.color }} />{priority.name}</span>;
}
export function SourceTag({ source }: { source?: { name: string; color: string } | null }) {
  if (!source) return <span className="text-ink-3">—</span>;
  return <span className="inline-flex items-center gap-1.5 text-[13px]"><span className="size-1.5 rounded-sm" style={{ background: source.color }} />{source.name}</span>;
}
export const followUpIcon = (t: string, cls = 'size-4') => {
  const map: Record<string, React.ReactNode> = { CALL: <Phone className={cls} />, WHATSAPP: <MessageCircle className={cls} />, EMAIL: <Mail className={cls} />, MEETING: <Users className={cls} />, VIDEO_CALL: <Video className={cls} />, NOTE: <StickyNote className={cls} /> };
  return map[t] ?? <CircleEllipsis className={cls} />;
};
