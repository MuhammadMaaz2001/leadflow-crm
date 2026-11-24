'use client';
import * as React from 'react';
import { Checkbox as RCheckbox, Switch as RSwitch } from 'radix-ui';
import { Check, ChevronDown, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

const base = 'w-full rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink shadow-card placeholder:text-ink-3 transition-shadow focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:bg-subtle disabled:text-ink-3';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(({ className, invalid, ...p }, ref) => (
  <input ref={ref} className={cn(base, 'h-8', invalid && 'border-bad focus:border-bad focus:ring-bad/20', className)} aria-invalid={invalid || undefined} {...p} />
));
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(({ className, invalid, ...p }, ref) => (
  <textarea ref={ref} className={cn(base, 'min-h-[76px] resize-y py-2', invalid && 'border-bad', className)} aria-invalid={invalid || undefined} {...p} />
));
Textarea.displayName = 'Textarea';

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(({ className, invalid, children, ...p }, ref) => (
  <div className="relative">
    <select ref={ref} className={cn(base, 'h-8 appearance-none pr-8', invalid && 'border-bad', className)} aria-invalid={invalid || undefined} {...p}>{children}</select>
    <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-3" aria-hidden />
  </div>
));
Select.displayName = 'Select';

export function Label({ children, required, htmlFor, className }: { children: React.ReactNode; required?: boolean; htmlFor?: string; className?: string }) {
  return (
    <label htmlFor={htmlFor} className={cn('mb-1 block text-xs font-medium text-ink-2', className)}>
      {children}{required && <span className="ml-0.5 text-bad" aria-hidden>*</span>}
    </label>
  );
}

/** Label + control + hint/error wrapper used by every form. */
export function Field({ label, required, error, hint, children, htmlFor, className }: { label?: string; required?: boolean; error?: string; hint?: string; children: React.ReactNode; htmlFor?: string; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      {label && <Label required={required} htmlFor={htmlFor}>{label}</Label>}
      {children}
      {error ? <p role="alert" className="mt-1 text-xs text-bad">{error}</p> : hint ? <p className="mt-1 text-xs text-ink-3">{hint}</p> : null}
    </div>
  );
}

export function Checkbox({ checked, onCheckedChange, indeterminate, ...p }: { checked: boolean; onCheckedChange: (v: boolean) => void; indeterminate?: boolean; 'aria-label'?: string; disabled?: boolean; id?: string }) {
  return (
    <RCheckbox.Root checked={indeterminate ? 'indeterminate' : checked} onCheckedChange={(v) => onCheckedChange(v === true)} {...p}
      className="flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-line-strong bg-surface shadow-card transition-colors data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent disabled:opacity-50">
      <RCheckbox.Indicator className="text-white">{indeterminate ? <Minus className="size-3" strokeWidth={3} /> : <Check className="size-3" strokeWidth={3} />}</RCheckbox.Indicator>
    </RCheckbox.Root>
  );
}

export function Switch({ checked, onCheckedChange, disabled, ...p }: { checked: boolean; onCheckedChange: (v: boolean) => void; disabled?: boolean; 'aria-label'?: string; id?: string }) {
  return (
    <RSwitch.Root checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} {...p}
      className="relative h-5 w-9 shrink-0 rounded-full bg-line-strong transition-colors data-[state=checked]:bg-accent disabled:opacity-50">
      <RSwitch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
    </RSwitch.Root>
  );
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return <div role="alert" className="rounded-md border border-bad/20 bg-bad-soft px-3 py-2 text-xs text-bad">{message}</div>;
}
