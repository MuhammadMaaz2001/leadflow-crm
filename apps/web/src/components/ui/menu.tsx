'use client';
import * as React from 'react';
import { DropdownMenu as RDD, Popover as RPop, Tooltip as RTip, Tabs as RTabs } from 'radix-ui';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export const DropdownMenu = RDD.Root;
export const DropdownTrigger = RDD.Trigger;
export function DropdownContent({ className, align = 'end', ...p }: React.ComponentProps<typeof RDD.Content>) {
  return (
    <RDD.Portal>
      <RDD.Content align={align} sideOffset={6} className={cn('animate-lf-pop z-50 min-w-[190px] overflow-hidden rounded-lg border border-line bg-surface p-1 shadow-pop', className)} {...p} />
    </RDD.Portal>
  );
}
export function DropdownItem({ className, destructive, icon, children, ...p }: React.ComponentProps<typeof RDD.Item> & { destructive?: boolean; icon?: React.ReactNode }) {
  return (
    <RDD.Item className={cn('flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 data-[highlighted]:bg-subtle', destructive ? 'text-bad data-[highlighted]:bg-bad-soft' : 'text-ink', className)} {...p}>
      {icon && <span className="text-ink-3 [&>svg]:size-3.5">{icon}</span>}{children}
    </RDD.Item>
  );
}
export function DropdownCheckItem({ checked, children, ...p }: React.ComponentProps<typeof RDD.Item> & { checked?: boolean }) {
  return (
    <RDD.Item className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none data-[highlighted]:bg-subtle" {...p}>
      <span className="flex size-3.5 items-center justify-center">{checked && <Check className="size-3.5 text-accent" />}</span>{children}
    </RDD.Item>
  );
}
export const DropdownLabel = ({ children }: { children: React.ReactNode }) => <RDD.Label className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-3">{children}</RDD.Label>;
export const DropdownSeparator = () => <RDD.Separator className="my-1 h-px bg-line" />;

export const Popover = RPop.Root;
export const PopoverTrigger = RPop.Trigger;
export function PopoverContent({ className, align = 'end', ...p }: React.ComponentProps<typeof RPop.Content>) {
  return (
    <RPop.Portal>
      <RPop.Content align={align} sideOffset={8} className={cn('animate-lf-pop z-50 rounded-xl border border-line bg-surface p-0 shadow-pop focus:outline-none', className)} {...p} />
    </RPop.Portal>
  );
}

export function Tooltip({ content, children, side = 'top' }: { content: React.ReactNode; children: React.ReactElement; side?: 'top' | 'right' | 'bottom' | 'left' }) {
  return (
    <RTip.Provider delayDuration={250}>
      <RTip.Root>
        <RTip.Trigger asChild>{children}</RTip.Trigger>
        <RTip.Portal>
          <RTip.Content side={side} sideOffset={6} className="animate-lf-fade z-[70] max-w-xs rounded-md bg-ink px-2 py-1 text-xs text-white shadow-pop">{content}</RTip.Content>
        </RTip.Portal>
      </RTip.Root>
    </RTip.Provider>
  );
}

export const Tabs = RTabs.Root;
export function TabsList({ className, ...p }: React.ComponentProps<typeof RTabs.List>) {
  return <RTabs.List className={cn('scroll-thin flex gap-1 overflow-x-auto border-b border-line', className)} {...p} />;
}
export function TabsTrigger({ className, ...p }: React.ComponentProps<typeof RTabs.Trigger>) {
  return <RTabs.Trigger className={cn('relative -mb-px whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-[13px] font-medium text-ink-2 transition-colors hover:text-ink data-[state=active]:border-accent data-[state=active]:text-ink', className)} {...p} />;
}
export const TabsContent = RTabs.Content;
