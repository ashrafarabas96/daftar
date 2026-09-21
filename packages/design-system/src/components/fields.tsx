'use client';
import { useId, useState, type ChangeEvent, type CSSProperties, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { colors, radius, spacing, TOUCH_TARGET, typography } from '../tokens';

const fieldShell: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: spacing[1],
  fontFamily: typography.fontFamily.base,
};

const inputBase: CSSProperties = {
  minHeight: TOUCH_TARGET,
  padding: `0 ${spacing[3]}`,
  borderRadius: radius.md,
  border: `1px solid ${colors.neutral[300]}`,
  fontSize: typography.size.md,
  fontFamily: typography.fontFamily.base,
  background: colors.neutral[0],
  color: colors.neutral[900],
  width: '100%',
};

const labelStyle: CSSProperties = { fontSize: typography.size.sm, fontWeight: typography.weight.medium, color: colors.neutral[700] };
const hintStyle: CSSProperties = { fontSize: typography.size.xs, color: colors.neutral[500] };
const errorStyle: CSSProperties = { ...hintStyle, color: colors.semantic.danger };

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  label: string;
  hint?: string;
  error?: string;
  onChange?: (value: string) => void;
}

export function TextField({ label, hint, error, onChange, id, style, ...rest }: TextFieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div style={{ ...fieldShell, ...style }}>
      <label htmlFor={inputId} style={labelStyle}>{label}</label>
      <input
        {...rest}
        id={inputId}
        aria-invalid={!!error}
        aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange?.(e.target.value)}
        style={{ ...inputBase, borderColor: error ? colors.semantic.danger : colors.neutral[300] }}
      />
      {error ? <span id={`${inputId}-error`} role="alert" style={errorStyle}>{error}</span> : hint ? <span id={`${inputId}-hint`} style={hintStyle}>{hint}</span> : null}
    </div>
  );
}

export function PasswordField(props: TextFieldProps) {
  const [visible, setVisible] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <TextField {...props} type={visible ? 'text' : 'password'} autoComplete={props.autoComplete ?? 'current-password'} />
      <button
        type="button"
        aria-label={visible ? 'hide password' : 'show password'}
        onClick={() => setVisible((v) => !v)}
        style={{
          position: 'absolute', insetInlineEnd: spacing[2], top: '2.1rem',
          background: 'none', border: 'none', cursor: 'pointer', color: colors.neutral[500],
          minWidth: TOUCH_TARGET, minHeight: TOUCH_TARGET,
        }}
      >
        {visible ? '◡' : '👁'}
      </button>
    </div>
  );
}

export function SearchField(props: Omit<TextFieldProps, 'type'>) {
  return <TextField {...props} type="search" role="search" />;
}

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange'> {
  label: string;
  hint?: string;
  error?: string;
  onChange?: (value: string) => void;
}

export function Textarea({ label, hint, error, onChange, id, style, ...rest }: TextareaProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div style={{ ...fieldShell, ...style }}>
      <label htmlFor={inputId} style={labelStyle}>{label}</label>
      <textarea
        {...rest}
        id={inputId}
        aria-invalid={!!error}
        onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange?.(e.target.value)}
        style={{ ...inputBase, minHeight: '6rem', padding: spacing[3], resize: 'vertical' }}
      />
      {error ? <span role="alert" style={errorStyle}>{error}</span> : hint ? <span style={hintStyle}>{hint}</span> : null}
    </div>
  );
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> {
  label: string;
  hint?: string;
  error?: string;
  options: { value: string; label: string }[];
  onChange?: (value: string) => void;
}

export function Select({ label, hint, error, options, onChange, id, style, ...rest }: SelectProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div style={{ ...fieldShell, ...style }}>
      <label htmlFor={inputId} style={labelStyle}>{label}</label>
      <select
        {...rest}
        id={inputId}
        aria-invalid={!!error}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange?.(e.target.value)}
        style={{ ...inputBase, borderColor: error ? colors.semantic.danger : colors.neutral[300] }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {error ? <span role="alert" style={errorStyle}>{error}</span> : hint ? <span style={hintStyle}>{hint}</span> : null}
    </div>
  );
}

export interface ComboboxProps extends Omit<TextFieldProps, 'onChange' | 'onSelect'> {
  options: { value: string; label: string }[];
  onSelect: (value: string) => void;
}

export function Combobox({ options, onSelect, ...rest }: ComboboxProps) {
  const autoId = useId();
  const listId = `${autoId}-list`;
  return (
    <div style={fieldShell}>
      <TextField {...rest} list={listId} role="combobox" aria-expanded={undefined} onChange={(v) => onSelect(v)} />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </datalist>
    </div>
  );
}

export interface CheckboxProps {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function Checkbox({ label, checked, onChange, disabled }: CheckboxProps) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: spacing[2], minHeight: TOUCH_TARGET, cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: typography.fontFamily.base }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ width: '1.25rem', height: '1.25rem', accentColor: colors.brand.primary }} />
      <span style={{ fontSize: typography.size.md, color: colors.neutral[800] }}>{label}</span>
    </label>
  );
}

export interface RadioCardProps {
  name: string;
  value: string;
  title: string;
  description?: string;
  checked: boolean;
  onChange: (value: string) => void;
}

export function RadioCard({ name, value, title, description, checked, onChange }: RadioCardProps) {
  return (
    <label
      style={{
        display: 'flex', gap: spacing[3], alignItems: 'flex-start',
        padding: spacing[4], borderRadius: radius.lg, cursor: 'pointer',
        border: `2px solid ${checked ? colors.brand.primary : colors.neutral[200]}`,
        background: checked ? colors.brand.primarySoft : colors.neutral[0],
        fontFamily: typography.fontFamily.base,
      }}
    >
      <input type="radio" name={name} value={value} checked={checked} onChange={() => onChange(value)} style={{ marginTop: spacing[1], accentColor: colors.brand.primary }} />
      <span>
        <span style={{ display: 'block', fontWeight: typography.weight.semibold, color: colors.neutral[900] }}>{title}</span>
        {description ? <span style={{ display: 'block', fontSize: typography.size.sm, color: colors.neutral[500] }}>{description}</span> : null}
      </span>
    </label>
  );
}

export function Switch({ label, checked, onChange, disabled }: CheckboxProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={typeof label === 'string' ? label : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: spacing[2],
        background: 'none', border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
        minHeight: TOUCH_TARGET, fontFamily: typography.fontFamily.base,
      }}
    >
      <span
        style={{
          width: '2.75rem', height: '1.5rem', borderRadius: radius.full,
          background: checked ? colors.brand.primary : colors.neutral[300],
          position: 'relative', transition: 'background 120ms ease-out', display: 'inline-block',
        }}
      >
        <span
          style={{
            position: 'absolute', top: '0.125rem', insetInlineStart: checked ? '1.375rem' : '0.125rem',
            width: '1.25rem', height: '1.25rem', borderRadius: radius.full, background: colors.neutral[0],
            transition: 'inset-inline-start 120ms ease-out',
          }}
        />
      </span>
      <span style={{ fontSize: typography.size.md, color: colors.neutral[800] }}>{label}</span>
    </button>
  );
}
