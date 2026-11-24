'use client';
import * as React from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { format } from 'date-fns';

export const PALETTE = ['#5558e3', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#94a3b8'];
const axis = { fontSize: 11, fill: '#8b8b96' };

export const bucketLabel = (b: string, granularity = 'day') => { if (!/^\d{4}-\d{2}-\d{2}$/.test(b)) return b; const d = new Date(`${b}T12:00:00`); return granularity === 'month' ? format(d, 'MMM yy') : format(d, 'MMM d'); };

function TooltipBox({ active, payload, label, valueFormatter }: { active?: boolean; payload?: Array<{ name?: string; value?: number; color?: string; dataKey?: string }>; label?: string; valueFormatter?: (v: number, k: string) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-pop">
      {label && <p className="mb-1 font-medium text-ink">{label}</p>}
      {payload.map((p) => <p key={p.dataKey} className="flex items-center gap-2 text-ink-2"><span className="size-2 rounded-full" style={{ background: p.color }} />{p.name}: <b className="tnum text-ink">{valueFormatter ? valueFormatter(p.value ?? 0, String(p.dataKey)) : p.value}</b></p>)}
    </div>
  );
}

export function TrendChart({ data, series, granularity, height = 240 }: { data: Array<Record<string, number | string>>; series: Array<{ key: string; name: string; color: string }>; granularity?: string; height?: number }) {
  return (
    <div style={{ height }} role="img" aria-label="Trend chart">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <defs>{series.map((s) => <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={s.color} stopOpacity={0.22} /><stop offset="100%" stopColor={s.color} stopOpacity={0} /></linearGradient>)}</defs>
          <CartesianGrid vertical={false} stroke="#ececf0" />
          <XAxis dataKey="bucket" tickFormatter={(b) => bucketLabel(String(b), granularity)} tick={axis} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis allowDecimals={false} tick={axis} tickLine={false} axisLine={false} />
          <RTooltip content={<TooltipBox />} labelFormatter={(b) => bucketLabel(String(b), granularity)} />
          {series.map((s) => <Area key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} fill={`url(#g-${s.key})`} dot={false} activeDot={{ r: 3.5 }} />)}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function HBarChart({ data, height = 240, valueFormatter, nameKey = 'name', valueKey = 'value', colorKey = 'color' }: { data: Array<Record<string, string | number>>; height?: number; valueFormatter?: (v: number) => string; nameKey?: string; valueKey?: string; colorKey?: string }) {
  return (
    <div style={{ height }} role="img" aria-label="Bar chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 0, bottom: 0 }} barCategoryGap={8}>
          <CartesianGrid horizontal={false} stroke="#ececf0" />
          <XAxis type="number" allowDecimals={false} tick={axis} tickLine={false} axisLine={false} tickFormatter={valueFormatter} />
          <YAxis type="category" dataKey={nameKey} width={104} tick={{ ...axis, fill: '#55555f' }} tickLine={false} axisLine={false} />
          <RTooltip cursor={{ fill: '#f4f4f5' }} content={<TooltipBox valueFormatter={valueFormatter ? (v) => valueFormatter(v) : undefined} />} />
          <Bar dataKey={valueKey} name="Value" radius={[0, 4, 4, 0]} maxBarSize={18}>{data.map((d, i) => <Cell key={i} fill={String(d[colorKey] ?? PALETTE[i % PALETTE.length])} />)}</Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function StackedBars({ data, series, granularity, height = 220, valueFormatter }: { data: Array<Record<string, number | string>>; series: Array<{ key: string; name: string; color: string }>; granularity?: string; height?: number; valueFormatter?: (v: number, k: string) => string }) {
  return (
    <div style={{ height }} role="img" aria-label="Bar chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="#ececf0" />
          <XAxis dataKey="bucket" tickFormatter={(b) => bucketLabel(String(b), granularity)} tick={axis} tickLine={false} axisLine={false} minTickGap={20} />
          <YAxis allowDecimals={false} tick={axis} tickLine={false} axisLine={false} />
          <RTooltip cursor={{ fill: '#f4f4f5' }} content={<TooltipBox valueFormatter={valueFormatter} />} labelFormatter={(b) => bucketLabel(String(b), granularity)} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
          {series.map((s) => <Bar key={s.key} dataKey={s.key} name={s.name} fill={s.color} radius={[3, 3, 0, 0]} maxBarSize={22} />)}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function RateLine({ data, height = 200 }: { data: Array<{ bucket: string; rate: number }>; height?: number }) {
  return (
    <div style={{ height }} role="img" aria-label="Conversion trend">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, left: -14, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="#ececf0" />
          <XAxis dataKey="bucket" tickFormatter={(b) => bucketLabel(String(b), 'month')} tick={axis} tickLine={false} axisLine={false} />
          <YAxis unit="%" domain={[0, 100]} tick={axis} tickLine={false} axisLine={false} />
          <RTooltip content={<TooltipBox valueFormatter={(v) => `${v}%`} />} labelFormatter={(b) => bucketLabel(String(b), 'month')} />
          <Line type="monotone" dataKey="rate" name="Conversion" stroke="#5558e3" strokeWidth={2} dot={{ r: 3, fill: '#5558e3' }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Donut({ data, height = 180, center }: { data: Array<{ name: string; value: number; color?: string }>; height?: number; center?: React.ReactNode }) {
  const total = data.reduce((a, d) => a + d.value, 0);
  return (
    <div className="relative" style={{ height }} role="img" aria-label="Distribution chart">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={total ? data : [{ name: 'None', value: 1 }]} dataKey="value" nameKey="name" innerRadius="64%" outerRadius="92%" paddingAngle={total ? 2 : 0} stroke="none">
            {(total ? data : [{ name: 'None', value: 1, color: '#ececf0' }]).map((d, i) => <Cell key={i} fill={d.color ?? PALETTE[i % PALETTE.length]} />)}
          </Pie>
          {total > 0 && <RTooltip content={<TooltipBox />} />}
        </PieChart>
      </ResponsiveContainer>
      {center && <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">{center}</div>}
    </div>
  );
}

export function Legend2({ items }: { items: Array<{ name: string; value: number | string; color: string }> }) {
  return <ul className="space-y-1.5 text-[13px]">{items.map((i) => <li key={i.name} className="flex items-center justify-between gap-3"><span className="flex min-w-0 items-center gap-2"><span className="size-2 shrink-0 rounded-full" style={{ background: i.color }} /><span className="truncate text-ink-2">{i.name}</span></span><b className="tnum">{i.value}</b></li>)}</ul>;
}
