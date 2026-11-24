'use client';
import * as React from 'react';
import { Dialog as RDialog } from 'radix-ui';
import { AlertTriangle, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './button';

interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** when true, closing asks for confirmation (unsaved changes) */
  dirty?: boolean;
}
const widths = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };

function useGuardedClose(dirty: boolean | undefined, onOpenChange: (o: boolean) => void) {
  const confirm = useConfirm();
  return React.useCallback(async (next: boolean) => {
    if (!next && dirty) {
      const ok = await confirm({ title: 'Discard unsaved changes?', description: 'You have changes that have not been saved. They will be lost.', confirmLabel: 'Discard changes', destructive: true });
      if (!ok) return;
    }
    onOpenChange(next);
  }, [dirty, onOpenChange, confirm]);
}

export function Dialog({ open, onOpenChange, title, description, children, footer, size = 'md', dirty }: ModalProps) {
  const guarded = useGuardedClose(dirty, onOpenChange);
  return (
    <RDialog.Root open={open} onOpenChange={guarded}>
      <RDialog.Portal>
        <RDialog.Overlay className="animate-lf-fade fixed inset-0 z-50 bg-[#0c0c14]/40 backdrop-blur-[1px]" />
        <RDialog.Content className={cn('animate-lf-pop fixed left-1/2 top-1/2 z-50 flex max-h-[min(88vh,820px)] w-[calc(100vw-24px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-line bg-surface shadow-pop focus:outline-none', widths[size])}>
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-3.5">
            <div className="min-w-0">
              <RDialog.Title className="text-[15px] font-semibold text-ink">{title}</RDialog.Title>
              {description ? <RDialog.Description className="mt-0.5 text-xs text-ink-2">{description}</RDialog.Description> : <RDialog.Description className="sr-only">{title}</RDialog.Description>}
            </div>
            <RDialog.Close asChild><Button variant="ghost" size="iconSm" aria-label="Close"><X className="size-4" /></Button></RDialog.Close>
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex items-center justify-end gap-2 border-t border-line bg-subtle/60 px-5 py-3 rounded-b-xl">{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

/** Right-hand side panel (full-screen bottom sheet on phones). */
export function Sheet({ open, onOpenChange, title, description, children, footer, width = 'max-w-xl', dirty }: Omit<ModalProps, 'size'> & { width?: string }) {
  const guarded = useGuardedClose(dirty, onOpenChange);
  return (
    <RDialog.Root open={open} onOpenChange={guarded}>
      <RDialog.Portal>
        <RDialog.Overlay className="animate-lf-fade fixed inset-0 z-50 bg-[#0c0c14]/40" />
        <RDialog.Content className={cn('animate-lf-slide-right fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-line bg-surface shadow-pop focus:outline-none max-sm:animate-lf-slide-up', width)}>
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <RDialog.Title className="text-[15px] font-semibold">{title}</RDialog.Title>
              {description ? <RDialog.Description className="mt-0.5 text-xs text-ink-2">{description}</RDialog.Description> : <RDialog.Description className="sr-only">{title}</RDialog.Description>}
            </div>
            <RDialog.Close asChild><Button variant="ghost" size="iconSm" aria-label="Close"><X className="size-4" /></Button></RDialog.Close>
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex items-center justify-end gap-2 border-t border-line bg-subtle/60 px-5 py-3">{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

// ── Promise based confirmation dialog ──
interface ConfirmOptions { title: string; description?: string; confirmLabel?: string; cancelLabel?: string; destructive?: boolean }
type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = React.createContext<ConfirmFn>(async () => false);
export const useConfirm = () => React.useContext(ConfirmContext);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = React.useCallback<ConfirmFn>((o) => new Promise((resolve) => setState({ ...o, resolve })), []);
  const close = (v: boolean) => { state?.resolve(v); setState(null); };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <RDialog.Root open={!!state} onOpenChange={(o) => { if (!o) close(false); }}>
        <RDialog.Portal>
          <RDialog.Overlay className="animate-lf-fade fixed inset-0 z-[60] bg-[#0c0c14]/45" />
          <RDialog.Content className="animate-lf-pop fixed left-1/2 top-1/2 z-[60] w-[calc(100vw-24px)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface p-5 shadow-pop focus:outline-none">
            <div className="flex gap-3">
              <div className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full', state?.destructive ? 'bg-bad-soft text-bad' : 'bg-accent-soft text-accent')}><AlertTriangle className="size-4" /></div>
              <div className="min-w-0">
                <RDialog.Title className="text-[15px] font-semibold">{state?.title}</RDialog.Title>
                <RDialog.Description className="mt-1 text-[13px] leading-5 text-ink-2">{state?.description ?? 'Are you sure you want to continue?'}</RDialog.Description>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button onClick={() => close(false)}>{state?.cancelLabel ?? 'Cancel'}</Button>
              <Button variant={state?.destructive ? 'danger' : 'primary'} onClick={() => close(true)} autoFocus>{state?.confirmLabel ?? 'Confirm'}</Button>
            </div>
          </RDialog.Content>
        </RDialog.Portal>
      </RDialog.Root>
    </ConfirmContext.Provider>
  );
}
