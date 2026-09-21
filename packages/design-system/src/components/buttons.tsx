'use client';
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import { colors, motion, radius, spacing, TOUCH_TARGET, typography } from '../tokens';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const sizeStyles: Record<Size, CSSProperties> = {
  sm: { minHeight: `calc(${TOUCH_TARGET} - 0.5rem)`, padding: `0 ${spacing[3]}`, fontSize: typography.size.sm },
  md: { minHeight: TOUCH_TARGET, padding: `0 ${spacing[4]}`, fontSize: typography.size.md },
  lg: { minHeight: `calc(${TOUCH_TARGET} + 0.5rem)`, padding: `0 ${spacing[6]}`, fontSize: typography.size.lg },
};

const variantStyles: Record<Variant, CSSProperties> = {
  primary: { background: colors.brand.primary, color: colors.brand.onPrimary, border: 'none' },
  secondary: { background: colors.neutral[0], color: colors.neutral[800], border: `1px solid ${colors.neutral[300]}` },
  ghost: { background: 'transparent', color: colors.brand.primary, border: 'none' },
  danger: { background: colors.semantic.danger, color: colors.neutral[0], border: 'none' },
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  fullWidth?: boolean;
}

export function Button({ variant = 'primary', size = 'md', loading, fullWidth, disabled, style, children, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing[2],
        borderRadius: radius.md,
        fontFamily: typography.fontFamily.base,
        fontWeight: typography.weight.semibold,
        cursor: disabled || loading ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: `background ${motion.fast}, opacity ${motion.fast}`,
        width: fullWidth ? '100%' : undefined,
        ...sizeStyles[size],
        ...variantStyles[variant],
        ...style,
      }}
    >
      {loading ? '…' : children}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  'aria-label': string;
  children: ReactNode;
}

export function IconButton({ children, style, ...rest }: IconButtonProps) {
  return (
    <button
      {...rest}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: TOUCH_TARGET,
        height: TOUCH_TARGET,
        borderRadius: radius.md,
        border: `1px solid ${colors.neutral[300]}`,
        background: colors.neutral[0],
        color: colors.neutral[700],
        cursor: 'pointer',
        ...style,
      }}
    >
      {children}
    </button>
  );
}
