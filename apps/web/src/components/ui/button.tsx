'use client';
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const variants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[13px] font-medium transition-colors select-none disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-white shadow-[0_1px_2px_rgb(16_16_28/0.2),inset_0_1px_0_rgb(255_255_255/0.14)] hover:bg-accent-hover',
        secondary: 'border border-line-strong bg-surface text-ink shadow-card hover:bg-subtle',
        ghost: 'text-ink-2 hover:bg-subtle hover:text-ink',
        danger: 'bg-bad text-white hover:bg-[#b83030]',
        dangerGhost: 'text-bad hover:bg-bad-soft',
        link: 'text-accent-ink underline-offset-4 hover:underline px-0',
      },
      size: { sm: 'h-7 px-2.5 text-xs', md: 'h-8 px-3', lg: 'h-9 px-4 text-sm', icon: 'h-8 w-8', iconSm: 'h-7 w-7' },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof variants> {
  loading?: boolean;
}
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, loading, disabled, children, type = 'button', ...props }, ref) => (
  <button ref={ref} type={type} disabled={disabled || loading} className={cn(variants({ variant, size }), className)} {...props}>
    {loading && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
    {children}
  </button>
));
Button.displayName = 'Button';
